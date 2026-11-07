package occcli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Helm and kubectl are real subprocesses. The loopback Kubernetes API fixture
// stores only Helm release Secrets; this does not establish cluster deployment.
func TestInstallationInstallOutputFailure(t *testing.T) {
	for _, tool := range []string{"helm", "kubectl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("requires " + tool)
		}
	}
	for _, phase := range []string{"healthy", "intent", "result"} {
		t.Run(phase, func(t *testing.T) {
			for _, setting := range os.Environ() {
				key, _, _ := strings.Cut(setting, "=")
				if strings.HasPrefix(key, "HELM_KUBE") || key == "HELM_DRIVER" {
					t.Setenv(key, "")
				}
			}
			var mu sync.Mutex
			var releases []json.RawMessage
			writes := 0
			releaseContentType := "application/json"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/version" {
					fmt.Fprint(w, `{"major":"1","minor":"35","gitVersion":"v1.35.0"}`)
					return
				}
				if r.Method == "GET" && r.URL.Path == "/api/v1/namespaces/operations" {
					fmt.Fprint(w, `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"operations"}}`)
					return
				}
				if serveJobDiscovery(w, r.URL.Path) {
					return
				}
				if r.URL.Path == "/api/v1/namespaces/operations/secrets" && r.Method == "GET" {
					mu.Lock()
					defer mu.Unlock()
					items := releases
					if items == nil {
						items = []json.RawMessage{}
					}
					if len(items) > 0 && !json.Valid(items[0]) {
						t.Error("unexpected list after protobuf Secret write")
						items = []json.RawMessage{}
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"apiVersion": "v1", "kind": "SecretList", "items": items})
					return
				}
				if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/operations/secrets/") {
					mu.Lock()
					defer mu.Unlock()
					if len(releases) == 0 {
						w.WriteHeader(404)
						return
					}
					w.Header().Set("Content-Type", releaseContentType)
					_, _ = w.Write(releases[0])
					return
				}
				if strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/operations/secrets") && (r.Method == "POST" || r.Method == "PUT") {
					raw, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						w.WriteHeader(500)
						return
					}
					mu.Lock()
					releases = []json.RawMessage{raw}
					releaseContentType = r.Header.Get("Content-Type")
					writes++
					mu.Unlock()
					w.Header().Set("Content-Type", r.Header.Get("Content-Type"))
					if r.Method == "POST" {
						w.WriteHeader(http.StatusCreated)
					}
					_, _ = w.Write(raw)
					return
				}
				if r.URL.Path == "/apis/batch/v1/namespaces/operations/jobs/demo-initialization" && r.Method == "GET" {
					w.WriteHeader(http.StatusNotFound)
					fmt.Fprint(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"NotFound","details":{"name":"demo-initialization","group":"batch","kind":"jobs"},"code":404}`)
					return
				}
				t.Errorf("unexpected Kubernetes request: %s %s", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
			}))
			defer server.Close()
			config := installationDoctorKubeconfig(t, server.URL)
			root := t.TempDir()
			chart := filepath.Join(root, "chart")
			if err := os.Mkdir(chart, 0700); err != nil {
				t.Fatal(err)
			}
			// An empty Helm chart isolates receipt/output handling from chart resources.
			// The production command still runs its real snapshot, list, install and read.
			if err := os.WriteFile(filepath.Join(chart, "Chart.yaml"), []byte("apiVersion: v2\nname: output-proof\nversion: 0.1.0\n"), 0600); err != nil {
				t.Fatal(err)
			}
			values := filepath.Join(root, "values.yaml")
			if err := os.WriteFile(values, []byte("{}\n"), 0600); err != nil {
				t.Fatal(err)
			}
			receipt := filepath.Join(root, "receipt")
			var stdout, stderr bytes.Buffer
			var output io.Writer = &stdout
			failure := errors.New("synthetic output delivery failure")
			if phase != "healthy" {
				remaining := 0
				if phase == "result" {
					remaining = len(fmt.Sprintf("Installation intent persisted in %s. An interrupted dispatch remains unknown; do not repeat install.\n", receipt))
				}
				output = &handoffFailingWriter{remaining: remaining, err: failure}
			}
			cmd := New(output, &stderr)
			cmd.SetArgs([]string{"installation", "install", "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo", "--chart", chart, "--values", values, "--receipt", receipt})
			err := cmd.ExecuteContext(t.Context())
			if phase == "healthy" {
				if err != nil || !strings.Contains(stdout.String(), "Helm outcome: succeeded.") {
					t.Fatalf("healthy install: out=%q err=%v stderr=%q", stdout.String(), err, stderr.String())
				}
			} else if !errors.Is(err, failure) {
				t.Errorf("error=%v, want the exact output delivery failure", err)
			}
			mu.Lock()
			count := writes
			mu.Unlock()
			if phase == "intent" {
				if count != 0 {
					t.Errorf("Helm mutated release storage %d times after intent output failed", count)
				}
				if _, err := os.Stat(filepath.Join(receipt, "dispatch.json")); !os.IsNotExist(err) {
					t.Errorf("failed intent output left dispatch evidence: %v", err)
				}
				if _, err := os.Stat(filepath.Join(receipt, "intent.json")); err != nil {
					t.Errorf("original persisted intent was lost: %v", err)
				}
			} else {
				if count == 0 {
					t.Error("real Helm did not write its release")
				}
				if outcome, err := readInstallationOutcome(receipt); err != nil || outcome != "succeeded" {
					t.Errorf("stored Helm outcome=%q err=%v", outcome, err)
				}
			}
		})
	}
}
