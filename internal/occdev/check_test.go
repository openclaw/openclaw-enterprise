//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These command-boundary cases protect target selection and the scaled-to-zero
// false positive. The managed real-cluster suite covers actual image failures.
func TestCheckRecordedProvisioningDependency(t *testing.T) {
	for _, tc := range []struct{ name, sandbox, server, context, replicas, want string }{
		{"ready", "openshell", "https://127.0.0.1:6443", "k3d-occ-dev-owned", "1", ""},
		{"rollout failure", "openshell", "https://127.0.0.1:6443", "k3d-occ-dev-owned", "1", "controller is unavailable"},
		{"zero replicas", "openshell", "https://127.0.0.1:6443", "k3d-occ-dev-owned", "0", "no verified ready replica"},
		{"foreign endpoint", "openshell", "https://example.test:6443", "k3d-occ-dev-owned", "1", "HTTPS loopback"},
		{"foreign context", "openshell", "https://127.0.0.1:6443", "other", "1", "context does not match"},
		{"no sandbox", "none", "https://127.0.0.1:6443", "k3d-occ-dev-owned", "0", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			state.SandboxDriver = tc.sandbox
			state.DockerHost = "unix:///recorded-engine.sock"
			state.KeyPath = filepath.Join(state.directory, "key.json")
			if err := os.Chmod(state.directory, 0700); err != nil {
				t.Fatal(err)
			}
			if err := rewriteState(state); err != nil {
				t.Fatal(err)
			}
			config := "current-context: " + tc.context + "\ncontexts:\n- name: " + tc.context + "\n  context:\n    cluster: recorded\nclusters:\n- name: recorded\n  cluster:\n    server: " + tc.server + "\n"
			for name, body := range map[string]string{".openclaw-development": stateMarker, "kubeconfig": config} {
				if err := os.WriteFile(filepath.Join(state.directory, name), []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			tools := t.TempDir()
			log := filepath.Join(tools, "calls")
			body := `#!/bin/sh
printf '%s\n' "$*" >> "$CHECK_CALLS"
case "$*" in
 'rollout status '*) if [ "$CHECK_ROLLOUT_FAILURE" = 1 ]; then printf '%s\n' 'synthetic-kubeconfig-credential' >&2; exit 1; fi; exit 0 ;;
 *' get deployment '*) printf '%s\n' '{"items":[{"kind":"Deployment","name":"agent-sandbox-controller","namespace":"agent-sandbox-system","uid":"11111111-1111-1111-1111-111111111111","selectorApp":"agent-sandbox-controller","selectorLabels":1,"readyReplicas":` + tc.replicas + `,"availableReplicas":` + tc.replicas + `}]}' ;;
 *) printf '%s\n' '{"items":[]}' ;;
esac
`
			if err := os.WriteFile(filepath.Join(tools, "kubectl"), []byte(body), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("CHECK_CALLS", log)
			t.Setenv("CHECK_ROLLOUT_FAILURE", "0")
			if tc.name == "rollout failure" {
				t.Setenv("CHECK_ROLLOUT_FAILURE", "1")
			}
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state.directory)
			t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "")
			var output, diagnostics bytes.Buffer
			err := Check(context.Background(), Options{Repository: state.Repository, Out: &output, Err: &diagnostics})
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q, got %v", tc.want, err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(output.String()+diagnostics.String(), "synthetic-kubeconfig-credential") {
				t.Fatal("raw kubectl output disclosed credential-bearing configuration")
			}
			calls, _ := os.ReadFile(log)
			if tc.sandbox == "none" || strings.HasPrefix(tc.name, "foreign") {
				if len(calls) != 0 {
					t.Fatal("queried Kubernetes without an applicable verified target")
				}
			} else if !bytes.Contains(calls, []byte("--context k3d-occ-dev-owned")) || !bytes.Contains(calls, []byte("--kubeconfig "+filepath.Join(state.directory, "kubeconfig"))) {
				t.Fatal("check did not pin the recorded target")
			}
			if tc.name == "zero replicas" && !strings.Contains(diagnostics.String(), `"diagnostic":"agent-sandbox-rollout"`) {
				t.Fatal("missing existing rollout diagnostic")
			}
			if _, err := readState(state.directory); err != nil {
				t.Fatalf("check damaged recorded state: %v", err)
			}
		})
	}
}
