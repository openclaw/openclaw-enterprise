package occdev

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
