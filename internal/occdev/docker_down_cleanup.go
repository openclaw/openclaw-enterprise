package occdev

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// developmentKeyDirectoryRecord lists, one per line, the service key
// directories scripts/dev-up created for this checkout's Docker-compatible
// stack. It lives in the checkout's browser directory, which survives
// stop/start; a --key-output path is never recorded.
const developmentKeyDirectoryRecord = "dev-up-key-directories"

const developmentKeyDirectoryPrefix = "openclaw-dev-up-key."

// removeRecordedDevelopmentKeyDirectories removes the key directories
// scripts/dev-up recorded in browserDirectory, then the record. A directory
// is removed only when it is still the private, owned directory dev-up made
// in the temporary directory and holds nothing but the copied service key
// (or an interrupted copy of it); anything else is kept and reported. The
// stack is already stopped, and the next start copies a new key.
func removeRecordedDevelopmentKeyDirectories(browserDirectory string, out, warnings io.Writer) {
	record := filepath.Join(browserDirectory, developmentKeyDirectoryRecord)
	data, err := os.ReadFile(record)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		fmt.Fprintf(warnings, "Warning: could not read %s: %v\n", record, err)
		return
	}
	var kept []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		directory := strings.TrimSpace(scanner.Text())
		if directory == "" {
			continue
		}
		removed, err := removeDevelopmentKeyDirectory(directory)
		if err != nil {
			fmt.Fprintf(warnings, "Warning: kept service key directory %s: %v\n", directory, err)
			kept = append(kept, directory)
			continue
		}
		if removed {
			fmt.Fprintf(out, "Removed service key directory %s.\n", directory)
		}
	}
	if len(kept) == 0 {
		if err := os.Remove(record); err != nil && !errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(warnings, "Warning: could not remove %s: %v\n", record, err)
		}
		return
	}
	// Keep the entries that still need attention so a later down retries them.
	if err := os.WriteFile(record, []byte(strings.Join(kept, "\n")+"\n"), 0600); err != nil {
		fmt.Fprintf(warnings, "Warning: could not update %s: %v\n", record, err)
	}
}

// removeDevelopmentKeyDirectory removes one recorded key directory. It
// reports false without error when the directory is already gone.
func removeDevelopmentKeyDirectory(directory string) (bool, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || !strings.HasPrefix(filepath.Base(directory), developmentKeyDirectoryPrefix) {
		return false, fmt.Errorf("not a directory occ dev up creates")
	}
	temporary, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return false, err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(directory))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if parent != temporary {
		return false, fmt.Errorf("not in the temporary directory %s", temporary)
	}
	if _, err := os.Lstat(directory); errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err := privateOwned(directory, true); err != nil {
		return false, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name != "initial-admin-service-key.json" && !strings.HasPrefix(name, ".dev-up-service-key.") {
			return false, fmt.Errorf("it holds %s, which occ dev up did not write", name)
		}
		if err := privateOwned(filepath.Join(directory, name), false); err != nil {
			return false, err
		}
	}
	for _, entry := range entries {
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
			return false, err
		}
	}
	return true, os.Remove(directory)
}
