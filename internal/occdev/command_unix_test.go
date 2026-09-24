//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"context"
	"testing"
	"time"
)

func TestCommandCancellationBoundsOwnedGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	// The shell and its child share the group owned by the runner. The child
	// would otherwise keep captured stdout open after the shell is cancelled.
	_, err := newRunner(Options{}).output(ctx, "/bin/sh", "-c", "sleep 5 & wait")
	if err == nil {
		t.Fatal("cancelled command succeeded")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("owned command group retained its pipe for %s", elapsed)
	}
}

func TestCommandCancelledBeforeStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := newRunner(Options{})
	if _, err := r.output(ctx, "/bin/sh", "-c", "exit 0"); err == nil {
		t.Fatal("cancelled command succeeded")
	}
	if r.unsettled {
		t.Fatal("a command that never started cannot leave an unsettled process")
	}
}
