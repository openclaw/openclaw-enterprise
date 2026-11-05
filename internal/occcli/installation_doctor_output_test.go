//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occcli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// This exercises the real Cobra command and kubectl subprocess boundary. The
// local executable supplies Job JSON only; it is not cluster integration proof.
func TestInstallationHandoffOutput(t *testing.T) {
	const completeMessage = "Initialization Job (install hook): complete. The chart reports migration and bootstrap completed (created or verified existing installation). Current database state and external provisioning are not verified. This Job does not establish Helm release status or whether the API and worker Deployments rolled out and are ready."
	const unresolvedMessage = "Initialization Job: completion not established. Inspect this attempt before any retry."
	const identity = "\nObserved Job synthetic/synthetic-initialization, UID \"synthetic-job\" (compare with the installation record).\n"
	const doctor = "API attempt: if started, inspect the original attempt and its outcome. Do not replay an uncertain operation.\nTemporary access: removal unknown. Verify separately with the access owner.\nRuntime: not qualified by this check.\n"
	const planTail = "2. If an API operation was attempted, inspect that original attempt before another write. Never replay an uncertain operation.\n3. Verify temporary access was removed, separately with the access owner.\n4. Qualify useful work from the installed Agent.\n"
	for _, action := range []string{"doctor", "plan"} {
		for _, state := range []string{"complete", "unresolved"} {
			message, status := completeMessage, `"succeeded":1,"conditions":[{"type":"Complete","status":"True"}]`
			next := "Establish whether this retained Job is the original. Without that link, the original outcome remains unknown."
			if state == "unresolved" {
				message, status = unresolvedMessage, `"active":1`
				next = "Resolve the identity, progress and effects of this initialization Job before considering another attempt."
			}
			want := message + identity + doctor
			if action == "plan" {
				want = message + identity + "Resume in order:\n1. " + next + "\n" + planTail
			}
			for _, output := range []string{"healthy", "failed-first", "failed-after-state"} {
				t.Run(action+"/"+state+"/"+output, func(t *testing.T) {
					dir := t.TempDir()
					// PATH contains only this fixture. The shell uses builtins, checks the
					// exact read request, and records every invocation to detect extra reads.
					script := `#!/bin/sh
printf '%s\n' "$*" >> "$0.calls"
[ "$#" = 7 ] && [ "$1" = '--kubeconfig=synthetic-config' ] && [ "$2" = '--context=synthetic-context' ] && [ "$3" = get ] && [ "$4" = jobs.v1.batch ] && [ "$5" = synthetic-initialization ] && [ "$6" = '--namespace=synthetic' ] && [ "$7" = '--output=json' ] || exit 91
printf '%s\n' '{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"synthetic-initialization","namespace":"synthetic","uid":"synthetic-job","labels":{"app.kubernetes.io/instance":"synthetic","app.kubernetes.io/name":"openclaw-enterprise","app.kubernetes.io/component":"initialization","app.kubernetes.io/managed-by":"Helm"},"annotations":{"helm.sh/hook":"pre-install,pre-upgrade"}},"spec":{"template":{"spec":{"initContainers":[{"name":"migration","args":["scripts/migrate-production.mjs","--expect-empty"]}],"containers":[{"name":"bootstrap","args":["scripts/bootstrap-installation.mjs"]}]}}},"status":{` + status + `}}'
`
					executable := filepath.Join(dir, "kubectl")
					if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
						t.Fatal(err)
					}
					t.Setenv("PATH", dir)
					failure := errors.New("synthetic output failure")
					var buf strings.Builder
					var out io.Writer = &buf
					if output != "healthy" {
						limit := 0
						if output == "failed-after-state" {
							limit = len(message + identity)
						}
						out = &handoffFailingWriter{remaining: limit, err: failure}
					}
					app := &application{parsedTimeout: 5 * time.Second}
					cmd := app.installationHandoffCommand(action)
					cmd.SetOut(out)
					cmd.SetErr(io.Discard)
					cmd.SilenceErrors, cmd.SilenceUsage = true, true
					cmd.SetArgs([]string{"--kubeconfig=synthetic-config", "--context=synthetic-context", "--kube-namespace=synthetic", "--release=synthetic"})
					err := cmd.Execute()
					calls, readErr := os.ReadFile(executable + ".calls")
					expectedCall := "--kubeconfig=synthetic-config --context=synthetic-context get jobs.v1.batch synthetic-initialization --namespace=synthetic --output=json\n"
					if readErr != nil || string(calls) != expectedCall {
						t.Fatalf("kubectl calls = %q, error = %v", calls, readErr)
					}
					if output != "healthy" {
						if !errors.Is(err, failure) {
							t.Fatalf("error = %v; want exact synthetic output failure", err)
						}
						var exit *ExitStatusError
						if errors.As(err, &exit) {
							t.Fatalf("output failure mistaken for domain exit: %v", err)
						}
						return
					}
					if buf.String() != want {
						t.Errorf("output = %q; want %q", buf.String(), want)
					}
					if state == "complete" {
						if err != nil {
							t.Fatalf("completed Job: %v", err)
						}
					} else {
						var exit *ExitStatusError
						if !errors.As(err, &exit) || exit.Code != 1 {
							t.Fatalf("unresolved Job: error = %v; want domain exit 1", err)
						}
					}
				})
			}
		}
	}
}

type handoffFailingWriter struct {
	remaining int
	err       error
}

func (w *handoffFailingWriter) Write(p []byte) (int, error) {
	n := min(len(p), w.remaining)
	w.remaining -= n
	if n < len(p) {
		return n, w.err
	}
	return n, nil
}

// The receipt branch adds a Helm outcome line before the Job report. An output
// error on that first line must not be hidden by later successful writes.
func TestInstallationReceiptOutput(t *testing.T) {
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("requires kubectl")
	}
	const attempt = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const job = `{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"demo-initialization","namespace":"operations","uid":"id","labels":{"app.kubernetes.io/instance":"demo","app.kubernetes.io/name":"openclaw-enterprise","app.kubernetes.io/component":"initialization","app.kubernetes.io/managed-by":"Helm"},"annotations":{"helm.sh/hook":"pre-install,pre-upgrade","openclaw.dev/installation-attempt":"` + attempt + `"}},"spec":{"template":{"spec":{"initContainers":[{"name":"migration","args":["scripts/migrate-production.mjs","--expect-empty"]}],"containers":[{"name":"bootstrap","args":["scripts/bootstrap-installation.mjs"]}]}}},"status":{"succeeded":1,"conditions":[{"type":"Complete","status":"True"}]}}`
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && serveJobDiscovery(w, r.URL.Path) {
			return
		}
		requests.Add(1)
		if r.Method != http.MethodGet || r.URL.RequestURI() != "/apis/batch/v1/namespaces/operations/jobs/demo-initialization" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, job)
	}))
	defer server.Close()
	config := installationDoctorKubeconfig(t, server.URL)
	_, cluster, err := snapshotInstallationConfig(context.Background(), config, "read", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	// Use the persisted production format and original Job UID, so a healthy
	// output writer reaches the genuine successful receipt reconciliation path.
	for name, value := range map[string]any{
		"intent.json":      installationIntent{Version: 1, Operation: "helm-install", Attempt: attempt, ClusterSHA256: cluster, Namespace: "operations", Release: "demo", ChartSHA256: strings.Repeat("c", 64), ValuesSHA256: strings.Repeat("d", 64)},
		"job.json":         installationJobReceipt{Attempt: attempt, UID: "id"},
		"helm-result.json": map[string]string{"outcome": "succeeded"},
	} {
		if err := writeInstallationRecord(directory, name, value); err != nil {
			t.Fatal(err)
		}
	}
	for _, action := range []string{"doctor", "plan"} {
		for _, fail := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/fail-first-write=%t", action, fail), func(t *testing.T) {
				requests.Store(0)
				failure := errors.New("synthetic first output failure")
				var output strings.Builder
				var writer io.Writer = &output
				if fail {
					writer = &handoffFirstWriteFailure{err: failure}
				}
				cmd := New(writer, io.Discard)
				cmd.SetArgs([]string{"installation", action, "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo", "--receipt", directory})
				err := cmd.Execute()
				if requests.Load() != 1 {
					t.Fatalf("Job requests = %d; want one read", requests.Load())
				}
				if fail {
					if !errors.Is(err, failure) {
						t.Fatalf("error = %v; want first output failure", err)
					}
				} else if err != nil || !strings.HasPrefix(output.String(), "Helm outcome: succeeded.\n") || !strings.Contains(output.String(), "matches the recorded UID") {
					t.Fatalf("healthy receipt: output=%q error=%v", output.String(), err)
				}
			})
		}
	}
}

type handoffFirstWriteFailure struct{ err error }

func (w *handoffFirstWriteFailure) Write(p []byte) (int, error) {
	if w.err != nil {
		err := w.err
		w.err = nil
		return 0, err
	}
	return len(p), nil
}
