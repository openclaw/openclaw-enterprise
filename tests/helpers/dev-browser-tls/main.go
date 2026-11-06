// Command dev-browser-tls provisions HTTPS for the disposable Console browser fixture.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/openclaw/openclaw-enterprise/internal/devtls"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 2 || !regexp.MustCompile(`^console-browser-[a-f0-9]{12}$`).MatchString(args[1]) {
		return fmt.Errorf("usage: dev-browser-tls DIRECTORY console-browser-<12 hex digits>")
	}
	directory, scope := args[0], args[1]
	consoleHost, nativeDomain, cookieDomain := devtls.BrowserHosts(scope)
	files, _, err := devtls.Generate("browser", "OCC development browser CA", []string{consoleHost, "*." + nativeDomain})
	if err != nil {
		return err
	}
	if err := os.Mkdir(directory, 0700); err != nil {
		return err
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			return err
		}
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]string{
		"consoleHost":  consoleHost,
		"nativeDomain": nativeDomain,
		"cookieDomain": cookieDomain,
	})
}
