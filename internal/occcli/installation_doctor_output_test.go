//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occcli

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
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
