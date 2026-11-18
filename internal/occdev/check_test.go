//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These process-boundary cases exercise the actual projection and target checks.
// The managed real-cluster suite covers kubelet image failure and recovery.
func TestCheckRecordedProvisioningDependency(t *testing.T) {
	for _, scenario := range []string{"ready", "custom selector", "replacement pending", "zero replicas", "read failure", "foreign endpoint", "foreign context", "explicit proxy", "cancelled", "no sandbox"} {
		t.Run(scenario, func(t *testing.T) {
			_, state, diagnostics, directory := agentSandboxTestRunner(t)
			state.DockerHost = "unix:///recorded-engine.sock"
			state.KeyPath = filepath.Join(state.directory, "key.json")
			if scenario == "no sandbox" {
				state.SandboxDriver = "none"
			}
			if err := os.Chmod(state.directory, 0700); err != nil {
				t.Fatal(err)
			}
			if err := rewriteState(state); err != nil {
				t.Fatal(err)
			}
			selected, server, proxy, want := "k3d-"+state.Cluster, "https://127.0.0.1:6443", "", ""
			switch scenario {
			case "foreign endpoint":
				server, want = "https://example.test:6443", "HTTPS loopback"
			case "foreign context":
				selected, want = "other", "context does not match"
			case "explicit proxy":
				proxy, want = "https://example.test:8080", "explicit proxy"
			case "cancelled":
				want = "context canceled"
			case "zero replicas", "read failure":
				want = "readiness could not be verified"
			}
			config := map[string]any{
				"current-context": selected,
				"contexts":        []any{map[string]any{"name": selected, "context": map[string]any{"cluster": "recorded"}}},
				"clusters":        []any{map[string]any{"name": "recorded", "cluster": map[string]any{"server": server, "proxy-url": proxy}}},
			}
			data, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			for name, body := range map[string][]byte{".openclaw-development": []byte(stateMarker), "kubeconfig": data} {
				if err := os.WriteFile(filepath.Join(state.directory, name), body, 0600); err != nil {
					t.Fatal(err)
				}
			}
			labels := map[string]any{"app": agentSandboxName}
			if scenario == "custom selector" {
				labels["managed-by"] = "local-operator"
			}
			status := map[string]any{"readyReplicas": 1, "availableReplicas": 1, "observedGeneration": 1}
			if scenario == "zero replicas" {
				status["readyReplicas"], status["availableReplicas"] = 0, 0
			}
			generation := 1
			if scenario == "replacement pending" {
				generation = 2
			}
			deployment := map[string]any{
				"metadata": map[string]any{"name": agentSandboxName, "namespace": agentSandboxNamespace, "uid": "11111111-1111-1111-1111-111111111111", "generation": generation},
				"spec":     map[string]any{"selector": map[string]any{"matchLabels": labels}},
				"status":   status,
			}
			data, err = json.Marshal(deployment)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, "deployment.raw.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("OCC_TEST_SANDBOX_MODE", "project")
			if scenario == "read failure" {
				t.Setenv("OCC_TEST_SANDBOX_MODE", "denied")
			}
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state.directory)
			t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "")
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if scenario == "cancelled" {
				cancel()
			}
			var output bytes.Buffer
			err = Check(ctx, Options{Repository: state.Repository, Out: &output, Err: diagnostics})
			if want != "" {
				if err == nil || !strings.Contains(err.Error(), want) {
					t.Fatalf("want %q, got %v", want, err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(output.String()+diagnostics.String(), "PRIVATE-") {
				t.Fatal("raw kubectl output escaped the structured diagnostic")
			}
			calls, _ := os.ReadFile(filepath.Join(directory, "commands.log"))
			if scenario == "no sandbox" || strings.HasPrefix(scenario, "foreign") || scenario == "explicit proxy" || scenario == "cancelled" {
				if len(calls) != 0 {
					t.Fatal("queried Kubernetes without an applicable active target")
				}
			} else {
				for _, line := range strings.Split(string(calls), "\n") {
					if strings.HasPrefix(line, "kubectl ") && !strings.HasPrefix(line, "kubectl --kubeconfig "+filepath.Join(state.directory, "kubeconfig")+" --context k3d-"+state.Cluster+" ") {
						t.Fatal("check did not pin its recorded target")
					}
				}
			}
			if scenario == "zero replicas" && !strings.Contains(diagnostics.String(), `"diagnostic":"agent-sandbox-rollout"`) {
				t.Fatal("missing existing rollout diagnostic")
			}
			if _, err := readState(state.directory); err != nil {
				t.Fatalf("check damaged recorded state: %v", err)
			}
		})
	}
}
