package occcli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func checkoutRepository(operation, marker string) (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", err
	}
	const declaration = "module github.com/openclaw/openclaw-enterprise"
	for {
		modulePath := filepath.Join(directory, "go.mod")
		module, err := os.ReadFile(modulePath)
		content := string(module)
		line, _, hasNewline := strings.Cut(content, "\n")
		if err == nil && hasNewline && strings.TrimSuffix(line, "\r") == declaration {
			markerPath := filepath.Join(directory, marker)
			info, err := os.Lstat(markerPath)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return "", fmt.Errorf("inspect %q: %w", markerPath, err)
			}
			if err == nil {
				if info.Mode()&os.ModeSymlink != 0 {
					info, err = os.Stat(markerPath)
					if err != nil {
						return "", fmt.Errorf("inspect %q: %w", markerPath, err)
					}
				}
				if !info.Mode().IsRegular() {
					return "", fmt.Errorf("%q must be a regular file", markerPath)
				}
				if !strings.Contains(content, "\r\n") {
					return directory, nil
				}
				return "", fmt.Errorf("%q uses CRLF line endings; convert it to LF before running %s", modulePath, operation)
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	return "", fmt.Errorf("run %s from an OpenClaw Enterprise source checkout", operation)
}
