package occcli

import (
	"bytes"
	"context"
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
	script := "trap 'touch \"$TRAP_MARKER\"' EXIT\n: >\"$STARTED_MARKER\"\nsleep 30 >/dev/null 2>&1\n"
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
	if err := command.ExecuteContext(ctx); err == nil {
		t.Fatal("interrupted occ dev up exited successfully")
	}
	if elapsed := time.Since(begin); elapsed > 25*time.Second {
		t.Fatalf("occ dev up took %s to stop after the interrupt", elapsed)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("scripts/dev-up EXIT trap did not run after the interrupt: %v", err)
	}
}
