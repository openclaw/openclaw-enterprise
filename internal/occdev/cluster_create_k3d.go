package occdev

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
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
		// A cancelled create says nothing about the host's nat table.
		return k3dCreateError(err, output.Bytes(), r.legacyNATUnconfirmed && ctx.Err() == nil)
	}
}

// k3dCreateError repeats k3d's last error line, which a caller showing only
// the tail of startup output would otherwise lose behind the rollback, and
// adds at most one hint chosen by k3dFailureHint.
func k3dCreateError(err error, output []byte, legacyNATUnconfirmed bool) error {
	var detail strings.Builder
	if line := k3dLastError(output); line != "" {
		detail.WriteString("\nk3d reported: " + line)
	}
	if hint := k3dFailureHint(output, legacyNATUnconfirmed); hint != "" {
		detail.WriteString("\n" + hint)
	}
	return fmt.Errorf("k3d failed: %w%s", err, detail.String())
}

// k3d resolves a +channel image through update.k3s.io before it creates
// anything, and reports every failure of that lookup (TLS, HTTP status, DNS,
// timeout) as "error getting K3s version for channel ...".
var k3dChannelLookupFailure = regexp.MustCompile(`(?i)error getting K3s version for channel|update\.k3s\.io|channelserver`)

// The nat table failure shows in k3d's output only if a node log line
// reaches it, such as k3d's warning that quotes a fatal node log. Docker's
// own port-publishing iptables errors are not this failure.
var k3dLegacyNATFailure = regexp.MustCompile(`(?i)can't initialize iptables|iptables table|table 'nat'|iptable_nat`)

// Causes k3d's output can name that a missing nat table does not explain.
// k3d's own startup timeout ("context deadline exceeded") is not one: a
// node that cannot load the nat table fails exactly that way.
var k3dOtherFailure = regexp.MustCompile(`(?i)x509|certificate|tls:|status code '?\d{3}|\b404\b|no such host|server misbehaving|i/o timeout|Client\.Timeout|handshake timeout|pull access denied|manifest unknown|failed to pull|ErrImagePull|ImagePullBackOff|port is already allocated|driver failed programming external connectivity`)

// defaultK3sChannel is the Compose profile's node image without OpenShell;
// k3d resolves it through update.k3s.io.
const defaultK3sChannel = "+v1.35"

const k3sChannelLookupHint = "k3d could not resolve the K3s channel (OCC_DEVELOPMENT_K3S_IMAGE, default " + defaultK3sChannel + ") through update.k3s.io. Set OCC_DEVELOPMENT_K3S_IMAGE to an explicit Kubernetes 1.35-or-newer image and start again. See \"Local K3s image lookup fails\" in docs/guides/operate/troubleshooting.md."

// k3dFailureHint picks the hint for a failed k3d cluster create. A cause
// named in k3d's output wins; the nat hint after an undecided preflight is
// the fallback only when k3d's output names nothing else.
func k3dFailureHint(output []byte, legacyNATUnconfirmed bool) string {
	switch {
	case k3dChannelLookupFailure.Match(output):
		return k3sChannelLookupHint
	case k3dLegacyNATFailure.Match(output):
		return legacyNATFailureHint
	case k3dOtherFailure.Match(output):
		return ""
	case legacyNATUnconfirmed:
		return "Startup could not confirm that the host loaded " + legacyNATModule + ". " + legacyNATFailureHint
	}
	return ""
}

var k3dLogLevel = regexp.MustCompile(`^(?:FATA|ERRO)\[|^time="[^"]*" level=(?:fatal|error) `)
var k3dRollbackLine = regexp.MustCompile(`Rolling Back|Cluster creation FAILED`)
var k3dProgressLine = regexp.MustCompile(`^(?:INFO|DEBU|TRAC|WARN)\[|^time="[^"]*" level=(?:info|debug|trace|warning) `)
var terminalEscape = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

const k3dErrorLineLimit = 512

// k3dLastError returns k3d's last error line other than its rollback
// messages, which name no cause. Without one it falls back to the last
// rollback message, then to the last line k3d wrote that is not a progress
// or warning log line.
func k3dLastError(output []byte) string {
	lines := strings.Split(terminalEscape.ReplaceAllString(string(output), ""), "\n")
	var rollback, last string
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if line == "" {
			continue
		}
		if last == "" && !k3dProgressLine.MatchString(line) {
			last = line
		}
		if !k3dLogLevel.MatchString(line) {
			continue
		}
		if !k3dRollbackLine.MatchString(line) {
			return truncateLine(line)
		}
		if rollback == "" {
			rollback = line
		}
	}
	if rollback != "" {
		return truncateLine(rollback)
	}
	return truncateLine(last)
}

func truncateLine(line string) string {
	if len(line) <= k3dErrorLineLimit {
		return line
	}
	cut := k3dErrorLineLimit
	for cut > 0 && !utf8.RuneStart(line[cut]) {
		cut--
	}
	return line[:cut] + "..."
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
