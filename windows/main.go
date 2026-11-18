// PyNotebook for Windows.
//
// The exe contains the PyNotebook web app and the Python runtime (Pyodide). It serves
// them on http://127.0.0.1 and opens them in a Microsoft Edge (or Chrome) app window.
// Python runs inside that window; the exe only serves files, reads and writes the
// notebooks you open from File Explorer, and keeps downloaded packages for offline use.
//
// Launching it again (or double-clicking a notebook) opens another window of the
// running instance. It exits a few seconds after its last window closes.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	appVersion     = "dev"
	pyodideVersion = "0"
)

const (
	firstPort     = 38917 // fixed, so the app keeps the same origin (and its saved settings) between runs
	portAttempts  = 20
	idleExitAfter = 15 * time.Second
)

type instanceInfo struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

type App struct {
	dataDir    string
	cacheDir   string
	port       int
	token      string
	noBrowser  bool
	assets     *assetStore
	lockSHA    map[string]string
	httpClient *http.Client

	mu            sync.Mutex
	pending       map[string][]string // open id -> file paths
	clients       int
	everConnected bool
	lastClient    time.Time
	stdin         map[string]chan *string
	downloads     map[string]*sync.Mutex
}

func main() {
	var (
		port      = flag.Int("port", 0, "port to listen on (default: 38917 or the next free one)")
		noBrowser = flag.Bool("no-browser", false, "don't open a window; print the address instead")
		dataDir   = flag.String("data-dir", "", "folder for downloaded packages and logs")
		stayOpen  = flag.Bool("stay-open", false, "keep running after the last window closes")
	)
	flag.Parse()

	dir := *dataDir
	if dir == "" {
		dir = defaultDataDir()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fatal("PyNotebook can't create its data folder:\n" + dir + "\n\n" + err.Error())
	}
	setupLog(dir)

	var files []string
	for _, a := range flag.Args() {
		if abs, err := filepath.Abs(a); err == nil {
			files = append(files, abs)
		}
	}

	// Already running? Ask it to open a window (with these files) and leave.
	if *port == 0 && forwardToRunning(dir, files) {
		return
	}

	app := &App{
		dataDir:    dir,
		cacheDir:   filepath.Join(dir, "packages"),
		noBrowser:  *noBrowser,
		pending:    map[string][]string{},
		stdin:      map[string]chan *string{},
		downloads:  map[string]*sync.Mutex{},
		httpClient: &http.Client{Timeout: 5 * time.Minute},
	}
	os.MkdirAll(app.cacheDir, 0o755)
	var err error
	app.assets, err = loadAssets()
	if err != nil {
		fatal("PyNotebook is damaged (" + err.Error() + "). Download it again.")
	}
	app.lockSHA = app.assets.lockHashes()

	ln, err := app.listen(*port, dir, files)
	if err != nil {
		fatal("PyNotebook couldn't start its local server: " + err.Error())
	}
	if ln == nil {
		return // handed over to an instance that was starting at the same time
	}
	app.port = ln.Addr().(*net.TCPAddr).Port
	app.token = randomHex(16)
	writeInstance(dir, instanceInfo{Port: app.port, Token: app.token, PID: os.Getpid()})
	defer removeInstance(dir, app.token)

	srv := &http.Server{Handler: app.routes(), ReadHeaderTimeout: 15 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server stopped: %v", err)
		}
	}()
	log.Printf("PyNotebook %s listening on 127.0.0.1:%d", appVersion, app.port)

	app.openWindow(files)
	app.waitUntilIdle(*stayOpen)
}

// listen binds 127.0.0.1 on the fixed port, or the next free one. If the port belongs to
// another PyNotebook that is just starting, the files are handed to it and ln is nil.
func (a *App) listen(port int, dir string, files []string) (net.Listener, error) {
	if port != 0 {
		return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	}
	var lastErr error
	for p := firstPort; p < firstPort+portAttempts; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return ln, nil
		}
		lastErr = err
		if isPyNotebook(p) {
			// Another copy started a moment ago; give it time to write its instance file.
			for i := 0; i < 30; i++ {
				time.Sleep(100 * time.Millisecond)
				if forwardToRunning(dir, files) {
					return nil, nil
				}
			}
		}
	}
	return nil, lastErr
}

func (a *App) url(openID string) string {
	u := fmt.Sprintf("http://127.0.0.1:%d/app/index.html#pnb=%s", a.port, a.token)
	if openID != "" {
		u += "&open=" + openID
	}
	return u
}

// openWindow opens an app window, passing the files it should show.
func (a *App) openWindow(files []string) {
	id := ""
	if len(files) > 0 {
		id = randomHex(8)
		a.mu.Lock()
		a.pending[id] = files
		a.mu.Unlock()
	}
	u := a.url(id)
	if a.noBrowser {
		fmt.Println(u)
		return
	}
	if err := openAppWindow(u, filepath.Join(a.dataDir, "Browser")); err != nil {
		log.Printf("couldn't open a window: %v", err)
		showError("PyNotebook couldn't open its window.\n\nOpen this address in Microsoft Edge or Google Chrome:\n" + u)
	}
}

// waitUntilIdle returns when no window has been connected for a while.
func (a *App) waitUntilIdle(stayOpen bool) {
	start := time.Now()
	warned := false
	for {
		time.Sleep(time.Second)
		a.mu.Lock()
		clients, ever, last := a.clients, a.everConnected, a.lastClient
		a.mu.Unlock()
		if stayOpen || clients > 0 {
			continue
		}
		if ever && time.Since(last) > idleExitAfter {
			log.Printf("last window closed; exiting")
			return
		}
		if !ever && !warned && time.Since(start) > 2*time.Minute && !a.noBrowser {
			warned = true
			go showError("PyNotebook's window didn't open.\n\nOpen this address in Microsoft Edge or Google Chrome:\n" + a.url(""))
		}
		if !ever && time.Since(start) > 15*time.Minute {
			return
		}
	}
}

func (a *App) clientConnected() {
	a.mu.Lock()
	a.clients++
	a.everConnected = true
	a.mu.Unlock()
}

func (a *App) clientGone() {
	a.mu.Lock()
	a.clients--
	a.lastClient = time.Now()
	a.mu.Unlock()
}

// ---------------------------------------------------------------- single instance

func instancePath(dir string) string { return filepath.Join(dir, "instance.json") }

func writeInstance(dir string, info instanceInfo) {
	b, _ := json.Marshal(info)
	tmp := instancePath(dir) + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, instancePath(dir))
	}
}

func removeInstance(dir, token string) {
	var info instanceInfo
	if b, err := os.ReadFile(instancePath(dir)); err == nil && json.Unmarshal(b, &info) == nil && info.Token == token {
		os.Remove(instancePath(dir))
	}
}

func isPyNotebook(port int) bool {
	c := &http.Client{Timeout: 1500 * time.Millisecond}
	r, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/__pnb/id", port))
	if err != nil {
		return false
	}
	defer r.Body.Close()
	var v map[string]string
	return json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&v) == nil && v["app"] == "PyNotebook"
}

func forwardToRunning(dir string, files []string) bool {
	b, err := os.ReadFile(instancePath(dir))
	if err != nil {
		return false
	}
	var info instanceInfo
	if json.Unmarshal(b, &info) != nil || info.Port == 0 {
		return false
	}
	body, _ := json.Marshal(map[string]any{"files": files})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/__pnb/new-window", info.Port), bytes.NewReader(body))
	req.Header.Set("X-PNB-Token", info.Token)
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Timeout: 3 * time.Second}
	r, err := c.Do(req)
	if err != nil {
		return false
	}
	r.Body.Close()
	return r.StatusCode == http.StatusOK
}

// ---------------------------------------------------------------- helpers

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func setupLog(dir string) {
	p := filepath.Join(dir, "pynotebook.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 {
		os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(f)
	}
}

func fatal(msg string) {
	log.Print(msg)
	showError(msg)
	os.Exit(1)
}

func defaultDataDir() string {
	if base, err := os.UserCacheDir(); err == nil {
		return filepath.Join(base, "PyNotebook")
	}
	return filepath.Join(os.TempDir(), "PyNotebook")
}

func cleanName(name string) string {
	return strings.TrimSpace(filepath.Base(name))
}
