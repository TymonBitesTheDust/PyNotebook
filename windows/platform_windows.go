//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	user32            = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW   = user32.NewProc("MessageBoxW")
	advapi32          = syscall.NewLazyDLL("advapi32.dll")
	procRegCreateKey  = advapi32.NewProc("RegCreateKeyExW")
	procRegSetValue   = advapi32.NewProc("RegSetValueExW")
	procRegDeleteTree = advapi32.NewProc("RegDeleteTreeW")
	procRegDeleteVal  = advapi32.NewProc("RegDeleteValueW")
	procRegDeleteKey  = advapi32.NewProc("RegDeleteKeyW")
	shell32           = syscall.NewLazyDLL("shell32.dll")
	procSHChangeNotif = shell32.NewProc("SHChangeNotify")
)

const (
	createNoWindow   = 0x08000000
	hkeyCurrentUser  = 0x80000001
	hkeyLocalMachine = 0x80000002
	keyWrite         = 0x20006
	regNone          = 0
	regSZ            = 1
)

func showError(msg string) {
	t, _ := syscall.UTF16PtrFromString(msg)
	c, _ := syscall.UTF16PtrFromString("PyNotebook")
	const mbOK, mbIconError, mbSetForeground = 0x0, 0x10, 0x10000
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), mbOK|mbIconError|mbSetForeground)
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

// appPath reads "App Paths" (where installers register browsers) for an exe name.
func appPath(exe string) string {
	for _, root := range []syscall.Handle{hkeyCurrentUser, hkeyLocalMachine} {
		var key syscall.Handle
		sub, _ := syscall.UTF16PtrFromString(`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exe)
		if syscall.RegOpenKeyEx(root, sub, 0, syscall.KEY_READ, &key) != nil {
			continue
		}
		buf := make([]uint16, 1024)
		n := uint32(len(buf) * 2)
		var typ uint32
		err := syscall.RegQueryValueEx(key, nil, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n)
		syscall.RegCloseKey(key)
		if err == nil {
			p := strings.Trim(syscall.UTF16ToString(buf), `"`)
			if fileExists(p) {
				return p
			}
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// findBrowser prefers Microsoft Edge (part of Windows 10 and 11), then Chrome.
func findBrowser() string {
	if p := appPath("msedge.exe"); p != "" {
		return p
	}
	var candidates []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if base := os.Getenv(env); base != "" {
			candidates = append(candidates,
				filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(base, `Google\Chrome\Application\chrome.exe`))
		}
	}
	for _, c := range candidates {
		if strings.Contains(c, "Edge") && fileExists(c) {
			return c
		}
	}
	if p := appPath("chrome.exe"); p != "" {
		return p
	}
	for _, c := range candidates {
		if fileExists(c) {
			return c
		}
	}
	return ""
}

// openAppWindow opens the app in its own window (no tabs or address bar), using a
// separate browser profile so the app's settings and files stay apart from browsing.
func openAppWindow(url, profileDir string) error {
	browser := findBrowser()
	if browser == "" {
		return openDefaultBrowser(url)
	}
	os.MkdirAll(profileDir, 0o755)
	cmd := exec.Command(browser,
		"--app="+url,
		"--user-data-dir="+profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1280,860",
	)
	if err := cmd.Start(); err != nil {
		return openDefaultBrowser(url)
	}
	go cmd.Wait()
	return nil
}

func openDefaultBrowser(url string) error {
	cmd := hidden(exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url))
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// ---------------------------------------------------------------- "Open with" registration (per user)

func regSet(path, name, value string, typ uint32) error {
	p, _ := syscall.UTF16PtrFromString(path)
	var key syscall.Handle
	r, _, _ := procRegCreateKey.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(p)), 0, 0, 0, keyWrite, 0, uintptr(unsafe.Pointer(&key)), 0)
	if r != 0 {
		return syscall.Errno(r)
	}
	defer syscall.RegCloseKey(key)
	var namePtr *uint16
	if name != "" {
		namePtr, _ = syscall.UTF16PtrFromString(name)
	}
	if typ == regNone {
		r, _, _ = procRegSetValue.Call(uintptr(key), uintptr(unsafe.Pointer(namePtr)), 0, regNone, 0, 0)
	} else {
		data, _ := syscall.UTF16FromString(value)
		r, _, _ = procRegSetValue.Call(uintptr(key), uintptr(unsafe.Pointer(namePtr)), 0, uintptr(typ),
			uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	}
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

// regDeleteTree removes a key under HKEY_CURRENT_USER with everything below it.
func regDeleteTree(path string) {
	p, _ := syscall.UTF16PtrFromString(path)
	procRegDeleteTree.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(p)))
	// Older Windows versions leave the (now empty) key itself; remove it too.
	procRegDeleteKey.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(p)))
}

func regDeleteValue(path, name string) {
	p, _ := syscall.UTF16PtrFromString(path)
	var key syscall.Handle
	if syscall.RegOpenKeyEx(hkeyCurrentUser, p, 0, keyWrite, &key) != nil {
		return
	}
	n, _ := syscall.UTF16PtrFromString(name)
	procRegDeleteVal.Call(uintptr(key), uintptr(unsafe.Pointer(n)))
	syscall.RegCloseKey(key)
}

func registerOpenWith(exe string, enable bool) error {
	const classes = `Software\Classes\`
	types := []struct{ ext, progID, desc string }{
		{".ipynb", "PyNotebook.ipynb", "Jupyter notebook"},
		{".py", "PyNotebook.py", "Python file"},
	}
	if !enable {
		for _, t := range types {
			regDeleteValue(classes+t.ext+`\OpenWithProgids`, t.progID)
			regDeleteTree(classes + t.progID)
		}
		regDeleteTree(classes + `Applications\PyNotebook.exe`)
		procSHChangeNotif.Call(0x08000000, 0, 0, 0)
		return nil
	}
	command := `"` + exe + `" "%1"`
	icon := `"` + exe + `",0`
	app := classes + `Applications\PyNotebook.exe`
	steps := []func() error{
		func() error { return regSet(app, "FriendlyAppName", "PyNotebook", regSZ) },
		func() error { return regSet(app+`\DefaultIcon`, "", icon, regSZ) },
		func() error { return regSet(app+`\shell\open\command`, "", command, regSZ) },
	}
	for _, t := range types {
		t := t
		steps = append(steps,
			func() error { return regSet(classes+t.progID, "", t.desc, regSZ) },
			func() error { return regSet(classes+t.progID, "FriendlyTypeName", t.desc, regSZ) },
			func() error { return regSet(classes+t.progID+`\DefaultIcon`, "", icon, regSZ) },
			func() error { return regSet(classes+t.progID+`\shell\open`, "FriendlyAppName", "PyNotebook", regSZ) },
			func() error { return regSet(classes+t.progID+`\shell\open\command`, "", command, regSZ) },
			func() error { return regSet(classes+t.ext+`\OpenWithProgids`, t.progID, "", regNone) },
			func() error { return regSet(app+`\SupportedTypes`, t.ext, "", regSZ) },
		)
	}
	for _, s := range steps {
		if err := s(); err != nil {
			return errors.New("Windows refused the change (" + err.Error() + ")")
		}
	}
	procSHChangeNotif.Call(0x08000000, 0, 0, 0) // SHCNE_ASSOCCHANGED: refresh icons and menus
	return nil
}
