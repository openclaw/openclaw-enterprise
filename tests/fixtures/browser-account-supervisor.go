//go:build linux

// The disposable Docker fixture selects the recipient's DNS before starting the stock supervisor.
package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"
)

var resolver string

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--backend-descriptor-file" {
		deadline := time.Now().Add(time.Minute)
		for {
			contents, err := os.ReadFile("/etc/resolv.conf")
			if err == nil && strings.TrimSpace(string(contents)) == "nameserver "+resolver {
				break
			}
			if time.Now().After(deadline) {
				fmt.Fprintln(os.Stderr, "timed out waiting for the fixture DNS in the supervisor container")
				os.Exit(1)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	err := syscall.Exec("/stock-openshell-supervisor", os.Args, os.Environ())
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
