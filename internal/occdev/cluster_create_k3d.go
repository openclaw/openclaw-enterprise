package occdev

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"sync"
)

// A Podman machine can fail the first log read of a freshly started k3d node
// with "failed to obtain logs ... unable to open a handle to the library".
// k3d treats that as a failed start and rolls the whole cluster back, so the
// same create succeeds when run again. Only that error, after k3d reports a
// complete rollback, is retried, and only once: anything else, or a create
// that did not roll back, keeps its first failure.
var k3dTransientLogHandle = regexp.MustCompile(`failed to obtain logs [^\n]*unable to open a handle to the library`)
var k3dRolledBack = regexp.MustCompile(`all changes have been rolled back`)

const k3dCreateOutputLimit = 64 << 10

func (r *runner) createK3dCluster(ctx context.Context, args ...string) error {
	for attempt := 1; ; attempt++ {
		output := &tailBuffer{limit: k3dCreateOutputLimit}
		cmd := r.command(ctx, "k3d", args...)
		cmd.Stdout = io.MultiWriter(r.opts.Out, output)
		cmd.Stderr = io.MultiWriter(r.opts.Err, output)
		err := cmd.Run()
		if err == nil {
			return nil
		}
		if attempt == 1 && ctx.Err() == nil && k3dCreateRetryable(output.Bytes()) {
			fmt.Fprintln(r.opts.Out, "k3d rolled back after a transient container-engine log error; retrying cluster creation once...")
			continue
		}
		return fmt.Errorf("k3d failed: %w%s", err, r.legacyNATFailureHint())
	}
}

func k3dCreateRetryable(output []byte) bool {
	return k3dTransientLogHandle.Match(output) && k3dRolledBack.Match(output)
}

// tailBuffer keeps the last limit bytes written to it. k3d writes stdout and
// stderr from separate goroutines, so writes are serialized.
type tailBuffer struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if excess := len(b.data) - b.limit; excess > 0 {
		b.data = append(b.data[:0], b.data[excess:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.data)
}
