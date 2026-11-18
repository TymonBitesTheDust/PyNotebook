//go:build !windows

// Non-Windows builds exist to test the server (see tests/); they open the default browser.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

func showError(msg string) { fmt.Fprintln(os.Stderr, msg) }

func openAppWindow(url, profileDir string) error { return openDefaultBrowser(url) }

func openDefaultBrowser(url string) error {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	return exec.Command(name, url).Start()
}

func registerOpenWith(exe string, enable bool) error {
	return fmt.Errorf("only available on Windows")
}
