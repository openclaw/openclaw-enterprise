package occdev

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// k3dDirectImportAttempts bounds how often a direct archive import is tried
// when k3d loses its stream into the node.
const k3dDirectImportAttempts = 3

const k3dImportOutputLimit = 64 << 10

// importArchiveDirect streams an image archive into the cluster nodes with
// `k3d image import --mode direct`.
//
// k3d pipes the archive into `ctr image import -` over a Docker exec and
// inspects that exec right after attaching. Docker answers the attach before
// it marks the exec running, so k3d can read a not-yet-started exec as exited
// with code 0, close the connection, and report "failed to copy read stream.
// io: read/write on closed pipe" before ctr has read anything.
// Importing the same archive again is safe, so only that failure is retried, a
// bounded number of times; any other failure is returned at once.
func (r *runner) importArchiveDirect(ctx context.Context, archive, cluster string) error {
	for attempt := 1; ; attempt++ {
		output := &tailBuffer{limit: k3dImportOutputLimit}
		cmd := r.command(ctx, "k3d", "image", "import", "--mode", "direct", archive, "-c", cluster)
		cmd.Stdout = r.opts.Out
		cmd.Stderr = io.MultiWriter(r.opts.Err, output)
		err := cmd.Run()
		if err == nil {
			return nil
		}
		if attempt >= k3dDirectImportAttempts || ctx.Err() != nil || !k3dImportStreamClosed(string(output.Bytes())) {
			return fmt.Errorf("k3d failed: %w", err)
		}
		fmt.Fprintf(r.opts.Out, "k3d image import lost its stream into the node; retrying (attempt %d of %d)...\n", attempt+1, k3dDirectImportAttempts)
	}
}

// k3dImportStreamClosed reports whether k3d failed because it closed its own
// stream into the node: its stdin copy hit the connection k3d had closed ("use
// of closed network connection"), so the archive copy failed on the closed
// pipe. When ctr itself fails, the node closes the stream instead and the copy
// sees a broken pipe or reset, which is not retried.
func k3dImportStreamClosed(stderr string) bool {
	stderr = strings.ToLower(stderr)
	return strings.Contains(stderr, "failed to copy read stream") &&
		strings.Contains(stderr, "use of closed network connection") &&
		strings.Contains(stderr, "read/write on closed pipe")
}
