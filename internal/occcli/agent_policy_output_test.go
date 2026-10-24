package occcli

import (
	"encoding/json/v2"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// HTTP responses below are protocol fixtures, not a running OCC or Sandbox.
// A successful policy mutation must also finish successfully at the CLI. An
// output-format error after the request applied invites a conflicting retry.
func TestAgentPolicyCommandsDefaultToStructuredOutput(t *testing.T) {
	const namespace = "ns_11111111-1111-4111-8111-111111111111"
	const agent = "agt_22222222-2222-4222-8222-222222222222"
	const revision = "rev_33333333-3333-4333-8333-333333333333"
	base := "/namespaces/" + namespace + "/agents/" + agent + "/sandbox-policy/networking"
	file := filepath.Join(t.TempDir(), "additions.json")
	if err := os.WriteFile(file, []byte(`{"expectedVersion":1,"additions":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	key := writeKeyFile(t, `{"data":{"key":"synthetic-policy-key"}}`)
	for _, operation := range []struct {
		name, method, suffix, response string
		args                           []string
	}{
		{"get", "GET", "", `{"editingEnabled":true,"policy":{"id":"spl_1","namespaceId":"` + namespace + `","agentId":"` + agent + `","version":1,"additions":[]},"defaults":{},"ceiling":[]}`, nil},
		{"update", "PUT", "", `{"id":"spl_1","namespaceId":"` + namespace + `","agentId":"` + agent + `","version":2,"additions":[]}`, []string{"--file", file}},
		{"apply", "POST", "/apply", `{"id":"spl_1","namespaceId":"` + namespace + `","agentId":"` + agent + `","version":1,"additions":[],"application":{"id":"app_1","revisionId":"` + revision + `","policyVersion":1,"state":"pending","requestedBy":"admin","requestedAt":"2026-10-21T00:00:00Z"}}`, []string{"--revision", revision, "--expected-version", "1"}},
		{"editing", "PATCH", "/editing", `{"id":"` + agent + `","namespaceId":"` + namespace + `","name":"Synthetic Agent","configurationId":"cfg_1","backendId":null,"servicePrincipalId":"spn_1","executionMode":"embedded","status":"active","desiredRuntimeState":"running","sandboxPolicyEditing":true,"createdAt":"2026-10-21T00:00:00Z"}`, []string{"--enabled=true"}},
		{"recommendations", "GET", "/recommendations", `{"recommendations":[],"truncated":false}`, []string{"--revision", revision}},
	} {
		for _, output := range []string{"default", "json", "yaml", "table", "text"} {
			t.Run(operation.name+"/"+output, func(t *testing.T) {
				calls := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					wantPath := base + operation.suffix
					if operation.name == "recommendations" {
						wantPath = "/namespaces/" + namespace + "/agents/" + agent + "/revisions/" + revision + "/sandbox-policy/networking/recommendations"
					}
					if r.Method != operation.method || r.URL.Path != wantPath {
						t.Errorf("request = %s %s", r.Method, r.URL.Path)
					}
					w.Header().Set("content-type", "application/json")
					if operation.name == "apply" {
						w.WriteHeader(http.StatusAccepted)
					}
					fmt.Fprintf(w, `{"data":%s,"meta":{"requestId":"synthetic"}}`, operation.response)
				}))
				defer server.Close()
				args := []string{"--url", server.URL, "--service-key-file", key, "--namespace", namespace, "agent", "policy", operation.name, agent}
				args = append(args, operation.args...)
				if output != "default" {
					args = append(args, "--output", output)
				}
				var out, diagnostic strings.Builder
				command := New(&out, &diagnostic)
				command.SetArgs(args)
				err := command.Execute()
				if output == "table" || output == "text" {
					// Unsupported explicit formats must stop before a read or mutation.
					if err == nil || !strings.Contains(err.Error(), "invalid output format") || calls != 0 || out.Len() != 0 {
						t.Fatalf("unsupported %s: requests=%d, output=%q, error=%v", output, calls, out.String(), err)
					}
					return
				}
				if err != nil {
					t.Fatalf("policy request applied %d time(s), then CLI failed: %v; stderr=%s", calls, err, diagnostic.String())
				}
				if calls != 1 {
					t.Fatalf("requests = %d; want one", calls)
				}
				var result map[string]any
				if output == "yaml" {
					err = yaml.Unmarshal([]byte(out.String()), &result)
				} else {
					err = json.Unmarshal([]byte(out.String()), &result)
				}
				if err != nil || len(result) == 0 {
					t.Fatalf("unreadable policy result: %q, %v", out.String(), err)
				}
			})
		}
	}
}
