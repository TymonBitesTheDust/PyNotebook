package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// assets/app/*.gz is the web app; assets/pyodide/*.gz is Python (see build.sh).
//
//go:embed all:assets
var embedded embed.FS

const maxFileSize = 100 << 20

// ---------------------------------------------------------------- embedded files

type assetStore struct {
	fs fs.FS
}

func loadAssets() (*assetStore, error) {
	sub, err := fs.Sub(embedded, "assets")
	if err != nil {
		return nil, err
	}
	if _, err := fs.Stat(sub, "app/index.html.gz"); err != nil {
		return nil, errors.New("the app files are missing")
	}
	return &assetStore{fs: sub}, nil
}

// gz returns the gzip-compressed bytes of an embedded file, or nil.
func (s *assetStore) gz(name string) []byte {
	b, err := fs.ReadFile(s.fs, name+".gz")
	if err != nil {
		return nil
	}
	return b
}

func (s *assetStore) lockHashes() map[string]string {
	out := map[string]string{}
	b := s.gz("pyodide/pyodide-lock.json")
	if b == nil {
		return out
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return out
	}
	var lock struct {
		Packages map[string]struct {
			FileName string `json:"file_name"`
			SHA256   string `json:"sha256"`
		} `json:"packages"`
	}
	if json.NewDecoder(zr).Decode(&lock) == nil {
		for _, p := range lock.Packages {
			out[p.FileName] = strings.ToLower(p.SHA256)
		}
	}
	return out
}

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json", ".ipynb": "application/json", ".map": "application/json",
	".wasm": "application/wasm", ".zip": "application/zip", ".whl": "application/zip", ".tar": "application/x-tar",
	".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
}

func contentType(name string) string {
	if t, ok := contentTypes[strings.ToLower(path.Ext(name))]; ok {
		return t
	}
	return "application/octet-stream"
}

func serveGz(w http.ResponseWriter, r *http.Request, name string, gz []byte) {
	w.Header().Set("Content-Type", contentType(name))
	w.Header().Set("Vary", "Accept-Encoding")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.Itoa(len(gz)))
		w.Write(gz)
		return
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		http.Error(w, "damaged file", 500)
		return
	}
	io.Copy(w, zr)
}

// ---------------------------------------------------------------- routing and security

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/app/index.html", http.StatusFound)
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/app/", a.serveApp)
	mux.HandleFunc("/pyodide/", a.servePyodide)
	mux.HandleFunc("/__stdin", a.stdinWait)
	mux.HandleFunc("/__pnb/id", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"app": "PyNotebook"})
	})
	api := map[string]http.HandlerFunc{
		"/__pnb/hello":       a.hello,
		"/__pnb/events":      a.events,
		"/__pnb/pending":     a.pendingFiles,
		"/__pnb/read":        a.readFile,
		"/__pnb/write":       a.writeFile,
		"/__pnb/open-url":    a.openURL,
		"/__pnb/cache":       a.listCache,
		"/__pnb/cache-clear": a.clearCache,
		"/__pnb/stdin-reply": a.stdinReply,
		"/__pnb/open-with":   a.openWith,
		"/__pnb/new-window":  a.newWindow,
	}
	for p, h := range api {
		mux.HandleFunc(p, a.requireToken(h))
	}
	return a.guard(mux)
}

// guard rejects requests that don't come from this computer's PyNotebook pages
// (other host names, as in DNS rebinding, or other websites posting to us) and adds
// the headers that let the page use SharedArrayBuffer.
func (a *App) guard(next http.Handler) http.Handler {
	allowed := map[string]bool{
		fmt.Sprintf("127.0.0.1:%d", a.port): true,
		fmt.Sprintf("localhost:%d", a.port): true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[r.Host] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && o != "null" {
			if u, err := url.Parse(o); err != nil || !allowed[u.Host] {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		h := w.Header()
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "credentialless")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "no-cache")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (a *App) requireToken(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t := r.Header.Get("X-PNB-Token")
		if t == "" {
			t = r.URL.Query().Get("t")
		}
		if t != a.token {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func readBody(r *http.Request, v any) error {
	if r.Method != http.MethodPost {
		return errors.New("use POST")
	}
	return json.NewDecoder(io.LimitReader(r.Body, maxFileSize+1<<20)).Decode(v)
}

// ---------------------------------------------------------------- app and Python files

func (a *App) serveApp(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/app/")
	if name == "" {
		name = "index.html"
	}
	if strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	if name == "build-info.json" {
		writeJSON(w, map[string]string{"app": appVersion, "pyodide": pyodideVersion, "platform": "windows"})
		return
	}
	gz := a.assets.gz("app/" + name)
	if gz == nil {
		http.NotFound(w, r)
		return
	}
	serveGz(w, r, name, gz)
}

func validPackageName(name string) bool {
	return name != "" && !strings.ContainsAny(name, `/\:`) && !strings.HasPrefix(name, ".") && len(name) < 200
}

// servePyodide serves Python's core files from the exe and packages from the
// download cache, fetching them from the Pyodide CDN the first time.
func (a *App) servePyodide(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/pyodide/")
	if !validPackageName(name) {
		http.NotFound(w, r)
		return
	}
	if gz := a.assets.gz("pyodide/" + name); gz != nil {
		serveGz(w, r, name, gz)
		return
	}
	file := filepath.Join(a.cacheDir, name)
	if _, err := os.Stat(file); err != nil {
		if err := a.download(name, file); err != nil {
			log.Printf("download %s: %v", name, err)
			writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("Couldn't download %s: %v", name, err))
			return
		}
	}
	w.Header().Set("Content-Type", contentType(name))
	http.ServeFile(w, r, file)
}

func (a *App) download(name, dest string) error {
	a.mu.Lock()
	m := a.downloads[name]
	if m == nil {
		m = &sync.Mutex{}
		a.downloads[name] = m
	}
	a.mu.Unlock()
	m.Lock()
	defer m.Unlock()
	if _, err := os.Stat(dest); err == nil {
		return nil
	}
	url := fmt.Sprintf("https://cdn.jsdelivr.net/pyodide/v%s/full/%s", pyodideVersion, name)
	resp, err := a.httpClient.Get(url)
	if err != nil {
		return fmt.Errorf("no internet connection? (%v)", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("the download server answered %s", resp.Status)
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	f.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if want := a.lockSHA[name]; want != "" && hex.EncodeToString(h.Sum(nil)) != want {
		os.Remove(tmp)
		return errors.New("the downloaded file was damaged; try again")
	}
	return os.Rename(tmp, dest)
}

func (a *App) listCache(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	}
	files := []entry{}
	ents, _ := os.ReadDir(a.cacheDir)
	for _, e := range ents {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".part") {
			continue
		}
		if info, err := e.Info(); err == nil {
			files = append(files, entry{e.Name(), info.Size()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	writeJSON(w, map[string]any{"files": files, "folder": a.cacheDir})
}

func (a *App) clearCache(w http.ResponseWriter, r *http.Request) {
	ents, _ := os.ReadDir(a.cacheDir)
	for _, e := range ents {
		if !e.IsDir() {
			os.Remove(filepath.Join(a.cacheDir, e.Name()))
		}
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- window session

func (a *App) hello(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"platform": "windows", "version": appVersion, "pyodide": pyodideVersion,
		"dataDir": a.dataDir, "packages": a.cacheDir,
	})
}

// events is a long-lived connection per window; PyNotebook exits when none are left.
func (a *App) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	a.clientConnected()
	defer a.clientGone()
	fmt.Fprint(w, "retry: 2000\n\n")
	fl.Flush()
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-t.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

func (a *App) newWindow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Files []string `json:"files"`
	}
	if err := readBody(r, &req); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	go a.openWindow(req.Files)
	writeJSON(w, map[string]bool{"ok": true})
}

type fileOut struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Text  string `json:"text,omitempty"`
	Error string `json:"error,omitempty"`
}

func readText(p string) (string, error) {
	st, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", errors.New("that's a folder, not a file")
	}
	if st.Size() > maxFileSize {
		return "", errors.New("the file is larger than 100 MB")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	if !utf8.Valid(b) {
		b = []byte(latin1ToUTF8(b))
	}
	return string(b), nil
}

// Older .py files on Windows are often in the ANSI code page; treat them as Latin-1.
func latin1ToUTF8(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

func (a *App) pendingFiles(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	a.mu.Lock()
	paths := a.pending[id]
	delete(a.pending, id)
	a.mu.Unlock()
	out := []fileOut{}
	for _, p := range paths {
		f := fileOut{Path: p, Name: filepath.Base(p)}
		if text, err := readText(p); err != nil {
			f.Error = fmt.Sprintf("Couldn't open %s: %v", f.Name, friendly(err))
		} else {
			f.Text = text
		}
		out = append(out, f)
	}
	writeJSON(w, map[string]any{"files": out})
}

func friendly(err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "it no longer exists"
	case errors.Is(err, os.ErrPermission):
		return "Windows didn't allow access to it"
	}
	return err.Error()
}

func (a *App) readFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readBody(r, &req); err != nil || !filepath.IsAbs(req.Path) {
		writeError(w, 400, "bad request")
		return
	}
	text, err := readText(req.Path)
	if err != nil {
		writeError(w, 404, fmt.Sprintf("Couldn't open %s: %s.", filepath.Base(req.Path), friendly(err)))
		return
	}
	writeJSON(w, fileOut{Path: req.Path, Name: filepath.Base(req.Path), Text: text})
}

// writeFile saves through a temporary file so a failed save never leaves half a notebook.
func (a *App) writeFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Text string `json:"text"`
	}
	if err := readBody(r, &req); err != nil || !filepath.IsAbs(req.Path) {
		writeError(w, 400, "bad request")
		return
	}
	if st, err := os.Stat(req.Path); err == nil && st.IsDir() {
		writeError(w, 400, "That's a folder, not a file.")
		return
	}
	tmp := req.Path + ".pynotebook-saving"
	err := os.WriteFile(tmp, []byte(req.Text), 0o644)
	if err == nil {
		if err = os.Rename(tmp, req.Path); err != nil {
			// e.g. the file is open in another program that blocks replacing it
			os.Remove(tmp)
			err = os.WriteFile(req.Path, []byte(req.Text), 0o644)
		}
	}
	if err != nil {
		os.Remove(tmp)
		writeError(w, 500, fmt.Sprintf("Couldn't save %s: %s.", filepath.Base(req.Path), friendly(err)))
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) openURL(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := readBody(r, &req); err != nil {
		writeError(w, 400, "bad request")
		return
	}
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "mailto") {
		writeError(w, 400, "Only web and email links can be opened.")
		return
	}
	if err := openDefaultBrowser(u.String()); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) openWith(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enable bool `json:"enable"`
	}
	if err := readBody(r, &req); err != nil {
		writeError(w, 400, "bad request")
		return
	}
	exe, err := os.Executable()
	if err == nil {
		err = registerOpenWith(exe, req.Enable)
	}
	if err != nil {
		writeError(w, 500, "Couldn't change Open with: "+err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- input() fallback

// stdinWait blocks until the page answers input(). Only used when the page isn't
// cross-origin isolated (otherwise input() uses shared memory).
func (a *App) stdinWait(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, 400, "missing id")
		return
	}
	ch := a.stdinChan(id)
	var text *string
	select {
	case text = <-ch:
	case <-r.Context().Done():
	case <-time.After(6 * time.Hour):
	}
	a.mu.Lock()
	delete(a.stdin, id)
	a.mu.Unlock()
	writeJSON(w, map[string]*string{"text": text})
}

func (a *App) stdinChan(id string) chan *string {
	a.mu.Lock()
	defer a.mu.Unlock()
	ch := a.stdin[id]
	if ch == nil {
		ch = make(chan *string, 1)
		a.stdin[id] = ch
	}
	return ch
}

func (a *App) stdinReply(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string  `json:"id"`
		Text *string `json:"text"`
	}
	if err := readBody(r, &req); err != nil {
		writeError(w, 400, "bad request")
		return
	}
	select {
	case a.stdinChan(req.ID) <- req.Text:
	default:
	}
	writeJSON(w, map[string]bool{"ok": true})
}
