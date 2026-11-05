package occdev

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestDevelopmentCommandTimingPreservesExecutionAndRedactsInputs(t *testing.T) {
	directory := t.TempDir()
	command := filepath.Join(directory, "docker")
	// The real child process emits output, fails, or waits for cancellation. This
	// proves the command boundary, not Docker or Kubernetes behavior.
	if err := os.WriteFile(command, []byte("#!/bin/sh\nprintf 'child-output'\nif [ \"$3\" = cancel ]; then exec sleep 30; fi\nexit \"$3\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"0", "23", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			var output, diagnostics bytes.Buffer
			r := newRunner(Options{Repository: directory, Out: &output, Err: &diagnostics})
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			err := r.run(ctx, command, "build", "private-command-input", mode)
			if (err == nil) != (mode == "0") {
				t.Fatalf("execution outcome changed: %v", err)
			}
			if mode == "cancel" && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
				t.Fatalf("the child did not remain under the command context: %v", ctx.Err())
			}
			if !strings.HasPrefix(output.String(), "child-output\n") {
				t.Fatalf("child stdout changed: %q", output.String())
			}
			failed := "true"
			if mode == "0" {
				failed = "false"
			}
			pattern := `^child-output\n\[occ-dev-timing\] stage=controller-build elapsed_ms=[0-9]+ failed=` + failed + "\n$"
			if !regexp.MustCompile(pattern).MatchString(output.String()) {
				t.Fatalf("unexpected diagnostic shape: %q", output.String())
			}
			if strings.Contains(output.String(), "private-command-input") || strings.Contains(output.String(), directory) {
				t.Fatal("timing retained command input or a local path")
			}
		})
	}
}
