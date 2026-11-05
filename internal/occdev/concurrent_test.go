package occdev

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// waitingStep starts a command that records its PID in pidFile and then waits
// until it is killed, so a test can tell whether concurrently stopped it.
func waitingStep(pidFile string) func(context.Context, *runner) error {
	return func(ctx context.Context, r *runner) error {
		return r.run(ctx, "sh", "-c", "echo $$ > "+shellQuote(pidFile)+"; exec sleep 30")
	}
}

// failingStep fails with cause once the sibling's command is running.
func failingStep(pidFile string, cause error) func(context.Context, *runner) error {
	return func(ctx context.Context, r *runner) error {
		for {
			if data, err := os.ReadFile(pidFile); err == nil && len(data) > 0 {
				return cause
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
}

// assertExited checks that the command whose PID is in pidFile was reaped.
func assertExited(t *testing.T, pidFile string) {
	t.Helper()
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("a canceled step left process %d behind: %v", pid, err)
	}
}

// overlapWriter records whether two writes were ever in progress at once. Each
// write holds briefly, so unserialized writers would overlap.
type overlapWriter struct {
	inFlight   atomic.Int32
	overlapped atomic.Bool
	mu         sync.Mutex
	data       bytes.Buffer
}

func (w *overlapWriter) Write(p []byte) (int, error) {
	if w.inFlight.Add(1) > 1 {
		w.overlapped.Store(true)
	}
	defer w.inFlight.Add(-1)
	time.Sleep(time.Millisecond)
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.data.Write(p)
}

func (w *overlapWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.data.String()
}

func TestConcurrentStepsShareOutputAndEnvironmentSafely(t *testing.T) {
	// One writer for both streams, as when a caller passes the same buffer.
	output := &overlapWriter{}
	r := &runner{opts: Options{Out: output, Err: output}, env: map[string]string{"PATH": os.Getenv("PATH"), "STEP": "parent"}}
	step := func(name string) func(context.Context, *runner) error {
		return func(ctx context.Context, r *runner) error {
			// Each step writes through its own runner; the parent's map stays unchanged.
			r.env["STEP"] = name
			return r.run(ctx, "sh", "-c", `for i in 1 2 3 4 5 6 7 8; do echo "$STEP $BUILDKIT_PROGRESS $i"; echo "$STEP err" >&2; sleep 0.01; done`)
		}
	}
	if err := r.concurrently(context.Background(), step("first"), step("second")); err != nil {
		t.Fatal(err)
	}
	if output.overlapped.Load() {
		t.Fatal("concurrent steps wrote to the shared output at the same time")
	}
	for _, name := range []string{"first", "second"} {
		if got := strings.Count(output.String(), name+" plain "); got != 8 {
			t.Fatalf("%s wrote %d of 8 lines with plain BuildKit progress: %q", name, got, output.String())
		}
		if got := strings.Count(output.String(), name+" err"); got != 8 {
			t.Fatalf("%s wrote %d of 8 diagnostics: %q", name, got, output.String())
		}
	}
	if r.env["STEP"] != "parent" {
		t.Fatalf("a step changed the caller's environment: %q", r.env["STEP"])
	}
}

func TestConcurrentStepFailureStopsItsSibling(t *testing.T) {
	for _, failing := range []int{0, 1} {
		t.Run("step "+strconv.Itoa(failing), func(t *testing.T) {
			pidFile := filepath.Join(t.TempDir(), "sibling.pid")
			cause := errors.New("import the development controller image: refused")
			steps := []func(context.Context, *runner) error{waitingStep(pidFile), waitingStep(pidFile)}
			steps[failing] = failingStep(pidFile, cause)
			r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			err := r.concurrently(ctx, steps...)
			// Only the failed step's own error is reported, not the sibling's
			// "signal: killed" from the cancellation it caused.
			if err != cause {
				t.Fatalf("want the failed step's error, got %v", err)
			}
			if ctx.Err() != nil {
				t.Fatal("the sibling ran until the test deadline instead of being canceled")
			}
			assertExited(t, pidFile)
		})
	}
}

func TestConcurrentStepsReportTheFirstStepWhenTheCallerCancels(t *testing.T) {
	directory := t.TempDir()
	first, second := filepath.Join(directory, "first.pid"), filepath.Join(directory, "second.pid")
	r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			firstPID, _ := os.ReadFile(first)
			secondPID, _ := os.ReadFile(second)
			if len(firstPID) > 0 && len(secondPID) > 0 {
				cancel()
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()

	err := r.concurrently(ctx,
		func(ctx context.Context, r *runner) error {
			if err := waitingStep(first)(ctx, r); err != nil {
				return errors.New("first step: " + err.Error())
			}
			return nil
		},
		waitingStep(second),
	)
	// Both steps fail only because the caller canceled, so neither is the cause;
	// the report is deterministic rather than whichever exited first.
	if err == nil || !strings.HasPrefix(err.Error(), "first step: ") {
		t.Fatalf("want the first step's error, got %v", err)
	}
	assertExited(t, first)
	assertExited(t, second)
}
