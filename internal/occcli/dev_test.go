package occcli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Interrupting occ dev up must let scripts/dev-up run its EXIT trap, which
// removes the private temporary directory holding the rendered Compose
// configuration (with interpolated development secrets).
func TestDevUpInterruptLetsTheStartupScriptCleanUp(t *testing.T) {
	repository := t.TempDir()
	marker := filepath.Join(repository, "trap-ran")
	started := filepath.Join(repository, "started")
	// The TERM trap exits 143, a plain status like a script that handles the
	// signal, so an interrupt must not be mistaken for the script's own failure.
	script := "trap 'touch \"$TRAP_MARKER\"' EXIT\ntrap 'kill $!; exit 143' TERM\n: >\"$STARTED_MARKER\"\nsleep 30 >/dev/null 2>&1 &\nwait $!\n"
	for path, contents := range map[string]string{
		"go.mod":         "module github.com/openclaw/openclaw-enterprise\n",
		"compose.yaml":   "services: {}\n",
		"scripts/dev-up": script,
	} {
		path = filepath.Join(repository, path)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(repository)
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker")
	t.Setenv("TRAP_MARKER", marker)
	t.Setenv("STARTED_MARKER", started)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(started); err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		cancel()
	}()

	command := New(&bytes.Buffer{}, &bytes.Buffer{})
	command.SetArgs([]string{"dev", "up"})
	begin := time.Now()
	err := command.ExecuteContext(ctx)
	if err == nil {
		t.Fatal("interrupted occ dev up exited successfully")
	}
	// An interrupt is reported as one, not as the script's own exit status.
	var status *ExitStatusError
	if errors.As(err, &status) {
		t.Fatalf("interrupted occ dev up passed on the script status %d", status.Code)
	}
	if elapsed := time.Since(begin); elapsed > 25*time.Second {
		t.Fatalf("occ dev up took %s to stop after the interrupt", elapsed)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("scripts/dev-up EXIT trap did not run after the interrupt: %v", err)
	}
}
