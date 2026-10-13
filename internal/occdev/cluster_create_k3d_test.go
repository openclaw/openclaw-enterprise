package occdev

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

const k3dLogHandleFailure = `echo 'ERRO[0002] Failed Cluster Start: Failed to start server k3d-occ-dev-test-server-0: Node k3d-occ-dev-test-server-0 failed to get ready: Failed waiting for log message '"'"'k3s is up and running'"'"' from node '"'"'k3d-occ-dev-test-server-0'"'"': docker failed to get logs from node '"'"'k3d-occ-dev-test-server-0'"'"' (container '"'"'bdd644e7'"'"'): Error response from daemon: failed to obtain logs for Container '"'"'bdd644e7'"'"': unable to open a handle to the library' >&2`
const k3dRollback = `echo 'FATA[0003] Cluster creation FAILED, all changes have been rolled back! ' >&2`

// fakeK3dCreate installs a k3d whose Nth `cluster create` runs the Nth body
// (the last body repeats) and records each call in a counter file.
func fakeK3dCreate(t *testing.T, bodies ...string) func() int {
	t.Helper()
	directory := t.TempDir()
	counter := filepath.Join(directory, "calls")
	var script strings.Builder
	script.WriteString("#!/bin/sh\n[ \"$1 $2\" = \"cluster create\" ] || { echo \"unexpected: k3d $*\" >&2; exit 99; }\n")
	script.WriteString("echo x >> '" + counter + "'\nn=$(wc -l < '" + counter + "')\n")
	for index, body := range bodies {
		condition := "[ \"$n\" -ge " + string(rune('1'+index)) + " ]"
		if index < len(bodies)-1 {
			condition = "[ \"$n\" -eq " + string(rune('1'+index)) + " ]"
		}
		script.WriteString("if " + condition + "; then\n" + body + "\nfi\n")
	}
	if err := os.WriteFile(filepath.Join(directory, "k3d"), []byte(script.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() int {
		data, err := os.ReadFile(counter)
		if err != nil {
			return 0
		}
		return strings.Count(string(data), "\n")
	}
}

func TestK3dCreateRetriesOnceAfterAPodmanLogHandleRollback(t *testing.T) {
	// Reproduces the Podman-machine failure from a real bring-up: the node
	// starts, its first log read fails, and k3d rolls the cluster back. The
	// same create then succeeds, so the launcher must not give up on it.
	calls := fakeK3dCreate(t,
		k3dLogHandleFailure+"\n"+k3dRollback+"\nexit 1",
		"echo 'INFO[0010] Cluster occ-dev-test created successfully!' >&2\nexit 0",
	)
	var out bytes.Buffer
	r := &runner{opts: Options{Out: &out, Err: io.Discard}, env: map[string]string{}}

	if err := r.createK3dCluster(context.Background(), "cluster", "create", "occ-dev-test"); err != nil {
		t.Fatalf("transient failure was not retried: %v", err)
	}
	if calls() != 2 {
		t.Fatalf("expected exactly one retry, got %d create calls", calls())
	}
	if !strings.Contains(out.String(), "retrying cluster creation once") {
		t.Fatalf("retry was not reported: %s", out.String())
	}
}

func TestK3dCreateRetriesTheLogHandleFailureOnlyOnce(t *testing.T) {
	calls := fakeK3dCreate(t, k3dLogHandleFailure+"\n"+k3dRollback+"\nexit 1")
	r := &runner{opts: Options{Out: io.Discard, Err: io.Discard}, env: map[string]string{}}

	if err := r.createK3dCluster(context.Background(), "cluster", "create", "occ-dev-test"); err == nil {
		t.Fatal("a repeated failure was reported as success")
	}
	if calls() != 2 {
		t.Fatalf("expected two create calls, got %d", calls())
	}
}

func TestK3dCreateDoesNotRetryOtherOrIncompleteFailures(t *testing.T) {
	for name, body := range map[string]string{
		// Another failure, even with a clean rollback, is not known to be transient.
		"other error": `echo 'ERRO[0001] Failed to create cluster: port is already allocated' >&2` + "\n" + k3dRollback + "\nexit 1",
		// Without a reported rollback the cluster may still exist; a second create
		// would collide with it and the launcher's own cleanup must handle it.
		"no rollback": k3dLogHandleFailure + "\nexit 1",
	} {
		t.Run(name, func(t *testing.T) {
			calls := fakeK3dCreate(t, body)
			r := &runner{opts: Options{Out: io.Discard, Err: io.Discard}, env: map[string]string{}}
			if err := r.createK3dCluster(context.Background(), "cluster", "create", "occ-dev-test"); err == nil {
				t.Fatal("failure was reported as success")
			}
			if calls() != 1 {
				t.Fatalf("expected no retry, got %d create calls", calls())
			}
		})
	}
}

// k3dChannelTLSFailure is k3d v5.8.3's output for `--image +v1.35` while
// update.k3s.io served a self-signed default certificate (2026-10-10 from
// 19:32Z); the Go error text was captured from that host the same evening.
const k3dChannelTLSFailure = `FATA[0000] error getting K3s version for channel v1.35: Get "https://update.k3s.io/v1-release/channels": tls: failed to verify certificate: x509: certificate is valid for 43e9310998f864bf7a19a94b424872d4.24fba67d861ea3ac85d8eb8a2cc5e210.traefik.default, not update.k3s.io`

// k3dStartupTimeout is a node that never logged "k3s is up and running",
// which is how a node without the nat table fails: kube-proxy's error is in
// the node log the rollback removes. The progress lines up to the server
// start are k3d v5.8.3's (trailing spaces included) from a real Compose
// profile startup on 10-05; the failure lines follow k3d's messages.
const k3dStartupTimeout = `INFO[0000] portmapping '127.0.0.1:13000:30080' targets the loadbalancer: defaulting to [servers:*:proxy agents:*:proxy] 
INFO[0000] Prep: Network                                
INFO[0000] Created network 'k3d-occ-dev-test'    
INFO[0000] Created image volume k3d-occ-dev-test-images 
INFO[0000] Starting new tools node...                   
INFO[0000] Starting node 'k3d-occ-dev-test-tools' 
INFO[0001] Creating node 'k3d-occ-dev-test-server-0' 
INFO[0001] Creating LoadBalancer 'k3d-occ-dev-test-serverlb' 
INFO[0001] Using the k3d-tools node to gather environment information 
INFO[0001] HostIP: using network gateway 10.89.0.1 address 
INFO[0001] Starting cluster 'occ-dev-test'       
INFO[0001] Starting servers...                          
INFO[0002] Starting node 'k3d-occ-dev-test-server-0' 
ERRO[0303] Failed Cluster Start: Failed to start server k3d-occ-dev-test-server-0: Node k3d-occ-dev-test-server-0 failed to get ready: Context deadline exceeded while waiting for log message 'k3s is up and running' of node k3d-occ-dev-test-server-0: context deadline exceeded
ERRO[0303] Failed to create cluster >>> Rolling Back
INFO[0303] Deleting cluster 'occ-dev-test'
FATA[0304] Cluster creation FAILED, all changes have been rolled back!`

func TestK3dCreateErrorHint(t *testing.T) {
	const (
		channelHint = `"Local K3s image lookup fails"`
		natHint     = "sudo modprobe --all iptable_nat"
		unconfirmed = "could not confirm that the host loaded iptable_nat"
	)
	for _, test := range []struct {
		name, output string
		// unconfirmed is the nat preflight's result; want and absent apply to
		// the error built for that state.
		unconfirmed  bool
		line         string
		want, absent []string
	}{
		{
			name: "channel lookup TLS failure", output: k3dChannelTLSFailure, unconfirmed: true,
			line: k3dChannelTLSFailure,
			want: []string{channelHint, "OCC_DEVELOPMENT_K3S_IMAGE"}, absent: []string{"iptable_nat"},
		},
		{
			name: "channel lookup HTTP 404", unconfirmed: true,
			output: "FATA[0000] error getting K3s version for channel v1.35: call made to 'https://update.k3s.io/v1-release/channels' failed with status code '404'",
			line:   "FATA[0000] error getting K3s version for channel v1.35: call made to 'https://update.k3s.io/v1-release/channels' failed with status code '404'",
			want:   []string{channelHint}, absent: []string{"iptable_nat"},
		},
		{
			name: "channel lookup DNS failure", unconfirmed: true,
			output: `FATA[0000] error getting K3s version for channel v1.35: Get "https://update.k3s.io/v1-release/channels": dial tcp: lookup update.k3s.io on 127.0.0.53:53: no such host`,
			line:   `FATA[0000] error getting K3s version for channel v1.35: Get "https://update.k3s.io/v1-release/channels": dial tcp: lookup update.k3s.io on 127.0.0.53:53: no such host`,
			want:   []string{channelHint}, absent: []string{"iptable_nat"},
		},
		{
			name: "channel lookup timeout", unconfirmed: true,
			output: `FATA[0030] error getting K3s version for channel v1.35: Get "https://update.k3s.io/v1-release/channels": dial tcp 34.208.215.203:443: i/o timeout`,
			line:   `FATA[0030] error getting K3s version for channel v1.35: Get "https://update.k3s.io/v1-release/channels": dial tcp 34.208.215.203:443: i/o timeout`,
			want:   []string{channelHint}, absent: []string{"iptable_nat"},
		},
		{
			name: "startup timeout after an undecided preflight", output: k3dStartupTimeout, unconfirmed: true,
			line: "ERRO[0303] Failed Cluster Start: Failed to start server k3d-occ-dev-test-server-0: Node k3d-occ-dev-test-server-0 failed to get ready: Context deadline exceeded while waiting for log message 'k3s is up and running' of node k3d-occ-dev-test-server-0: context deadline exceeded",
			want: []string{unconfirmed, natHint}, absent: []string{channelHint},
		},
		{
			name: "startup timeout after a confirmed preflight", output: k3dStartupTimeout,
			line:   "ERRO[0303] Failed Cluster Start: Failed to start server k3d-occ-dev-test-server-0: Node k3d-occ-dev-test-server-0 failed to get ready: Context deadline exceeded while waiting for log message 'k3s is up and running' of node k3d-occ-dev-test-server-0: context deadline exceeded",
			absent: []string{"iptable_nat", channelHint},
		},
		{
			// k3d quotes a fatal node log line in a warning before it retries.
			name: "node log names the nat table after a confirmed preflight",
			output: `WARN[0012] warning: encountered fatal log from node k3d-occ-dev-test-server-0 (retrying 0/10): time="2026-10-10T19:40:02Z" level=fatal msg="iptables v1.8.10 (legacy): can't initialize iptables table ` + "`nat'" + `: Table does not exist (do you need to insmod?)"` + "\n" +
				`ERRO[0040] Failed Cluster Start: Failed to start server k3d-occ-dev-test-server-0: Node k3d-occ-dev-test-server-0 failed to get ready: error waiting for log line ` + "`k3s is up and running`" + ` from node 'k3d-occ-dev-test-server-0': stopped returning log lines: node k3d-occ-dev-test-server-0 is running=false in status=exited` + "\n" + k3dRollbackLines,
			line: "ERRO[0040] Failed Cluster Start: Failed to start server k3d-occ-dev-test-server-0: Node k3d-occ-dev-test-server-0 failed to get ready: error waiting for log line `k3s is up and running` from node 'k3d-occ-dev-test-server-0': stopped returning log lines: node k3d-occ-dev-test-server-0 is running=false in status=exited",
			want: []string{natHint}, absent: []string{unconfirmed, channelHint},
		},
		{
			name: "image pull failure after an undecided preflight", unconfirmed: true,
			output: "ERRO[0004] Failed Cluster Creation: failed to create node 'k3d-occ-dev-test-server-0': docker failed to pull image 'docker.io/rancher/k3s:v1.35.99-k3s1': Error response from daemon: manifest for rancher/k3s:v1.35.99-k3s1 not found: manifest unknown: manifest unknown\n" + k3dRollbackLines,
			line:   "ERRO[0004] Failed Cluster Creation: failed to create node 'k3d-occ-dev-test-server-0': docker failed to pull image 'docker.io/rancher/k3s:v1.35.99-k3s1': Error response from daemon: manifest for rancher/k3s:v1.35.99-k3s1 not found: manifest unknown: manifest unknown",
			absent: []string{"iptable_nat", channelHint},
		},
		{
			// Docker's port publishing, not the node's nat table.
			name: "Docker port publishing failure after an undecided preflight", unconfirmed: true,
			output: "ERRO[0002] Failed Cluster Start: Failed to start server k3d-occ-dev-test-serverlb: Error response from daemon: driver failed programming external connectivity on endpoint k3d-occ-dev-test-serverlb (5e2c): (iptables failed: iptables --wait -t nat -A DOCKER -p tcp -d 127.0.0.1 --dport 6443 -j DNAT --to-destination 172.18.0.3:6443 ! -i br-5e2c: iptables: No chain/target/match by that name.\n" + k3dRollbackLines,
			line:   "ERRO[0002] Failed Cluster Start: Failed to start server k3d-occ-dev-test-serverlb: Error response from daemon: driver failed programming external connectivity on endpoint k3d-occ-dev-test-serverlb (5e2c): (iptables failed: iptables --wait -t nat -A DOCKER -p tcp -d 127.0.0.1 --dport 6443 -j DNAT --to-destination 172.18.0.3:6443 ! -i br-5e2c: iptables: No chain/target/match by that name.",
			absent: []string{"iptable_nat", channelHint},
		},
		{
			name: "progress lines only", output: "INFO[0001] Creating node 'k3d-occ-dev-test-server-0' \nWARN[0002] something to note\n", unconfirmed: true,
			want: []string{unconfirmed}, absent: []string{"k3d reported"},
		},
		{
			name: "port conflict after an undecided preflight", unconfirmed: true,
			output: "ERRO[0001] Failed to create cluster: port is already allocated\n" + k3dRollbackLines,
			line:   "ERRO[0001] Failed to create cluster: port is already allocated",
			absent: []string{"iptable_nat", channelHint},
		},
		{
			name: "only the rollback after an undecided preflight", output: k3dRollbackLines, unconfirmed: true,
			line: "FATA[0304] Cluster creation FAILED, all changes have been rolled back!",
			want: []string{unconfirmed, natHint},
		},
		{
			name: "colored output", output: "\x1b[31mFATA\x1b[0m[0000] error getting K3s version for channel v1.35: call made to 'https://update.k3s.io/v1-release/channels' failed with status code '404'\n",
			line: "FATA[0000] error getting K3s version for channel v1.35: call made to 'https://update.k3s.io/v1-release/channels' failed with status code '404'",
			want: []string{channelHint},
		},
		{name: "no output", unconfirmed: true, want: []string{unconfirmed, natHint}},
		{name: "no output after a confirmed preflight", absent: []string{"iptable_nat", "k3d reported"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := k3dCreateError(errors.New("exit status 1"), []byte(test.output), test.unconfirmed)
			lines := strings.Split(err.Error(), "\n")
			if lines[0] != "k3d failed: exit status 1" {
				t.Fatalf("first line %q", lines[0])
			}
			if test.line != "" && (len(lines) < 2 || lines[1] != "k3d reported: "+test.line) {
				t.Fatalf("k3d's error line is missing:\n%s", err)
			}
			for _, want := range test.want {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error does not contain %q:\n%s", want, err)
				}
			}
			for _, absent := range test.absent {
				if strings.Contains(err.Error(), absent) {
					t.Fatalf("error contains %q:\n%s", absent, err)
				}
			}
		})
	}
}

const k3dRollbackLines = `ERRO[0303] Failed to create cluster >>> Rolling Back
INFO[0303] Deleting cluster 'occ-dev-test'
FATA[0304] Cluster creation FAILED, all changes have been rolled back!`

// The 10-10 outage end to end: k3d's line and the lookup hint reach the
// error, and the nat hint does not, although the preflight was undecided.
func TestK3dCreateFailureNamesAFailedChannelLookup(t *testing.T) {
	fakeK3dCreate(t, "echo '"+strings.ReplaceAll(k3dChannelTLSFailure, "'", `'"'"'`)+"' >&2\nexit 1")
	r := &runner{opts: Options{Out: io.Discard, Err: io.Discard}, env: map[string]string{}, legacyNATUnconfirmed: true}
	err := r.createK3dCluster(context.Background(), "cluster", "create", "occ-dev-test")
	var exitErr *exec.ExitError
	if err == nil || !errors.As(err, &exitErr) || !strings.Contains(err.Error(), "k3d reported: "+k3dChannelTLSFailure) ||
		!strings.Contains(err.Error(), "Local K3s image lookup fails") || strings.Contains(err.Error(), "iptable_nat") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// A cancelled create gets k3d's line but no nat hint.
func TestK3dCreateCancelledSkipsTheNATHint(t *testing.T) {
	fakeK3dCreate(t, "exit 1")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &runner{opts: Options{Out: io.Discard, Err: io.Discard}, env: map[string]string{}, legacyNATUnconfirmed: true}
	err := r.createK3dCluster(ctx, "cluster", "create", "occ-dev-test")
	if err == nil || strings.Contains(err.Error(), "iptable_nat") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestK3dLastErrorTruncatesLongLines(t *testing.T) {
	line := k3dLastError([]byte("ERRO[0001] " + strings.Repeat("é", 400)))
	if len(line) > k3dErrorLineLimit+len("...") || !strings.HasSuffix(line, "...") || !utf8.ValidString(line) {
		t.Fatalf("line not truncated cleanly: %d bytes", len(line))
	}
}
