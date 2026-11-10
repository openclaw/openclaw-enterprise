package occdev

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestControllerBuildCancellationPreservesTiming(t *testing.T) {
	directory := t.TempDir()
	pidFile := filepath.Join(directory, "engine.pid")
	command := filepath.Join(directory, "docker")
	// Exercise the launcher's real process boundary, not Docker itself. A sibling
	// startup failure must stop the engine process and retain its timing record.
	if err := os.WriteFile(command, []byte("#!/bin/sh\necho $$ > "+shellQuote(pidFile)+"\nexec sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	repository, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	r := newRunner(Options{Repository: repository, Out: &output})
	r.engine = "docker"
	delete(r.env, "OCC_DEVELOPMENT_CONTROLLER_IMAGE")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cause := errors.New("routing installation failed")
	done := make(chan error, 1)
	go func() {
		done <- r.concurrently(ctx, func(ctx context.Context, r *runner) error {
			_, err := r.importDevelopmentController(ctx, &developmentState{})
			return err
		}, failingStep(pidFile, cause))
	}()
	select {
	case err := <-done:
		if !errors.Is(err, cause) {
			t.Fatalf("want the sibling failure, got %v", err)
		}
	case <-time.After(5 * time.Second):
		// Reap the regression's orphan before failing, so the proof leaves no build running.
		data, _ := os.ReadFile(pidFile)
		if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		cancel()
		<-done
		t.Fatal("canceling startup did not stop the controller build process")
	}
	assertExited(t, pidFile)
	if !strings.Contains(output.String(), "stage=controller-build") || !strings.Contains(output.String(), "failed=true") {
		t.Fatalf("missing failed controller-build timing: %q", output.String())
	}
}
