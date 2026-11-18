//go:build linux || darwin

package occdev

import (
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

func TestComposeCancellationStopsProviderDescendants(t *testing.T) {
	for _, invocation := range []string{"run", "capture", "bootstrap"} {
		t.Run(invocation, func(t *testing.T) {
			directory := t.TempDir()
			child := filepath.Join(directory, "child")
			late := filepath.Join(directory, "late")
			// The provider owns a further engine client which inherits its output
			// pipes and ignores TERM. Killing only the outer wrapper leaves it live.
			fakeEngine(t, "compose-engine", `"compose build bootstrap") ;;
*) /bin/sh -c 'trap "" TERM; echo $$ > "$CHILD"; sleep 3; touch "$LATE"' & wait ;;`)
			r := newRunner(Options{Repository: directory})
			r.engine = "compose-engine"
			r.env["CHILD"], r.env["LATE"] = child, late
			r.env["OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS"] = "1"
			state := &developmentState{directory: directory, ComposeProject: "occ-dev-cancel"}
			started := time.Now()
			// Bootstrap preparation must join the same provider descendants before
			// its caller can begin rollback or remove credential inputs.
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			var err error
			switch invocation {
			case "capture":
				_, err = r.composeOutput(ctx, state, "up")
			case "bootstrap":
				err = r.prepareBootstrapMounts(ctx, directory, []string{"compose"})
			default:
				err = r.compose(ctx, state, "up")
			}
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected readiness deadline: %v", err)
			}
			if time.Since(started) > 2500*time.Millisecond {
				t.Fatalf("provider was not joined promptly: %v", err)
			}
			data, err := os.ReadFile(child)
			if err != nil {
				t.Fatal(err)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil {
				t.Fatal(err)
			}
			if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
				t.Fatalf("provider descendant remains after cancellation: %v", err)
			}
			if _, err := os.Stat(late); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("descendant performed work after cancellation: %v", err)
			}
		})
	}
}

func TestComposeColdBuildDoesNotConsumeReadinessTimeout(t *testing.T) {
	fakeEngine(t, "compose-engine", `*" build "*) sleep 2 ;;`)
	r := newRunner(Options{Repository: t.TempDir()})
	r.engine = "compose-engine"
	r.env["OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS"] = "1"
	if err := r.compose(context.Background(), &developmentState{ComposeProject: "occ-dev-build"}, "build", "migrate"); err != nil {
		t.Fatalf("cold build inherited the readiness deadline: %v", err)
	}
}
