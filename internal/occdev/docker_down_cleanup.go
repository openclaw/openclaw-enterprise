package occdev

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
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

// Docker Compute labels each Namespace network it creates (see
// apps/controller/src/drivers/compute/docker); the Namespace ID label ties a
// network to the Installation whose database records that Namespace.
const (
	dockerComputeManagedLabel   = "org.openclaw.enterprise.managed=true"
	dockerComputeDriverLabel    = "org.openclaw.enterprise.compute-driver=docker"
	dockerComputeNamespaceLabel = "org.openclaw.enterprise.namespace-id="
)

var dockerNamespaceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)

// dockerNamespaceIDs reads the Namespace IDs of the Docker-compatible stack's
// Installation from its running database. compose is the Compose command
// and global options occ dev down uses for the stack.
func (r *runner) dockerNamespaceIDs(ctx context.Context, compose []string) ([]string, error) {
	args := append(append([]string(nil), compose...), "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "openclaw_enterprise", "-AtX", "-c", "SELECT id FROM occ.namespaces")
	data, err := r.output(ctx, r.engine, args...)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, line := range strings.Split(string(data), "\n") {
		id := strings.TrimSpace(line)
		if id == "" {
			continue
		}
		if !dockerNamespaceID.MatchString(id) {
			return nil, fmt.Errorf("unexpected Namespace ID %q", id)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// removeDockerNamespaceNetworks removes the Docker Compute Namespace networks
// of the given Namespaces after down deleted their Installation's volumes.
// Only networks carrying the Docker Compute labels for one of those
// Namespace IDs are removed, never another stack's. A network still in use
// is kept and reported.
func (r *runner) removeDockerNamespaceNetworks(ctx context.Context, ids []string, lookupErr error) {
	if lookupErr != nil {
		fmt.Fprintf(r.opts.Err, "Warning: could not read the Installation's Namespaces before deleting its database (%v); "+
			"its Docker Compute Namespace networks (label %s) may remain\n", lookupErr, dockerComputeDriverLabel)
		return
	}
	for _, id := range ids {
		names, err := r.output(ctx, r.engine, "network", "ls", "--filter", "label="+dockerComputeManagedLabel, "--filter", "label="+dockerComputeDriverLabel, "--filter", "label="+dockerComputeNamespaceLabel+id, "--format", "{{.Name}}")
		if err != nil {
			fmt.Fprintf(r.opts.Err, "Warning: could not list the Docker Compute network of Namespace %s: %v\n", id, err)
			continue
		}
		for _, name := range strings.Fields(string(names)) {
			if _, err := r.output(ctx, r.engine, "network", "rm", name); err != nil {
				fmt.Fprintf(r.opts.Err, "Warning: kept Docker Compute Namespace network %s, which may still have containers: %v\n", name, err)
				continue
			}
			fmt.Fprintf(r.opts.Out, "Removed Docker Compute Namespace network %s.\n", name)
		}
	}
}
