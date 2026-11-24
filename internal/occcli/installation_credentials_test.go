package occcli

import (
	"encoding/base64"
	"encoding/json"
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

	"go.yaml.in/yaml/v3"
)

// Real Helm resolves the shipped chart and real kubectl creates the Secret.
// This API fixture proves local preparation and dispatch safety, not deployment,
// PostgreSQL registration, or authentication; those belong to the cluster suite.
func TestInstallationGeneratedCredentials(t *testing.T) {
	for _, tool := range []string{"helm", "kubectl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("requires " + tool)
		}
	}
	for _, phase := range []string{"confirmed", "already-exists", "conflict", "denied", "lost-response", "mutated-response"} {
		t.Run(phase, func(t *testing.T) {
			root := t.TempDir()
			stateRoot := root
			if phase == "confirmed" && os.Geteuid() != 0 {
				// A usable private state directory may have a traverse-only ancestor.
				// Durability must not require listing unrelated, existing ancestors.
				ancestor := filepath.Join(root, "traverse-only")
				stateRoot = filepath.Join(ancestor, "state")
				if err := os.MkdirAll(stateRoot, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(ancestor, 0111); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(ancestor, 0700) })
			}
			t.Setenv("XDG_STATE_HOME", stateRoot)
			receipt := filepath.Join(root, "receipt")
			var mu sync.Mutex
			var captured map[string]any
			posts := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/version" {
					fmt.Fprint(w, `{"major":"1","minor":"35","gitVersion":"v1.35.0"}`)
					return
				}
				if r.URL.Path == "/api/v1" {
					fmt.Fprint(w, `{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"v1","resources":[{"name":"secrets","kind":"Secret","namespaced":true,"verbs":["get","create","list"]}]}`)
					return
				}
				if serveJobDiscovery(w, r.URL.Path) {
					return
				}
				if phase == "already-exists" && r.Method == "GET" && r.URL.Path == "/api/v1/namespaces/operations/secrets/initial-access" {
					fmt.Fprint(w, `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"initial-access","namespace":"operations"}}`)
					return
				}
				if r.URL.Path == "/api/v1/namespaces/operations/secrets" && r.Method == "GET" {
					fmt.Fprint(w, `{"apiVersion":"v1","kind":"SecretList","items":[]}`)
					return
				}
				if r.URL.Path == "/api/v1/namespaces/operations/secrets" && r.Method == "POST" {
					mu.Lock()
					defer mu.Unlock()
					if strings.HasPrefix(r.Header.Get("Content-Type"), "application/vnd.kubernetes.protobuf") {
						w.WriteHeader(500)
						fmt.Fprint(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"InternalError","code":500}`)
						return
					}
					posts++
					raw, _ := io.ReadAll(r.Body)
					if json.Unmarshal(raw, &captured) != nil {
						t.Error("expected a JSON Secret from kubectl")
						w.WriteHeader(400)
						return
					}
					var marker map[string]string
					if err := readInstallationRecord(receipt, "bootstrap-secret-dispatch.json", &marker); err != nil || marker["outcome"] != "unknown" {
						t.Error("Secret dispatched without durable intent")
					}
					if phase == "conflict" || phase == "denied" || (phase == "lost-response" && posts > 1) {
						code, reason := 409, "AlreadyExists"
						if phase == "denied" {
							code, reason = 403, "Forbidden"
						}
						w.WriteHeader(code)
						fmt.Fprintf(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":%q,"code":%d}`, reason, code)
						return
					}
					if phase == "lost-response" {
						// The API received the create but its response is lost. A retry of the
						// same create gets AlreadyExists above, never a replacement update.
						connection, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
							return
						}
						_ = connection.Close()
						return
					}
					metadata := captured["metadata"].(map[string]any)
					metadata["uid"] = "11111111-1111-4111-8111-111111111111"
					response, _ := json.Marshal(captured)
					if phase == "mutated-response" {
						var altered map[string]any
						_ = json.Unmarshal(response, &altered)
						altered["data"].(map[string]any)["token"] = base64.StdEncoding.EncodeToString([]byte("different admitted value"))
						response, _ = json.Marshal(altered)
					}
					w.WriteHeader(201)
					_, _ = w.Write(response)
					return
				}
				// No workload endpoints are implemented: after confirmed Secret creation,
				// Helm cannot deploy this chart through a Secret-only protocol fixture.
				w.WriteHeader(404)
				fmt.Fprint(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"NotFound","code":404}`)
			}))
			defer server.Close()
			config := installationDoctorKubeconfig(t, server.URL)
			raw, err := os.ReadFile("../../deploy/examples/production/values.yaml")
			if err != nil {
				t.Fatal(err)
			}
			var values map[string]any
			if err = yaml.Unmarshal(raw, &values); err != nil {
				t.Fatal(err)
			}
			values["bootstrap"] = map[string]any{"adminEmail": "admin@example.invalid", "credentials": map[string]any{"secretName": "initial-access", "passwordKey": "login", "serviceKeyKey": "token"}}
			raw, err = yaml.Marshal(values)
			if err != nil {
				t.Fatal(err)
			}
			valuesPath := filepath.Join(root, "values.yaml")
			if err = os.WriteFile(valuesPath, raw, 0600); err != nil {
				t.Fatal(err)
			}
			out, stderr, runErr := runHelp(t, "installation", "install", "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo", "--chart", "../../deploy/helm/openclaw-enterprise", "--values", valuesPath, "--receipt", receipt)
			if runErr == nil {
				t.Fatal("Secret-only API fixture unexpectedly deployed the chart")
			}
			mu.Lock()
			secret := captured
			count := posts
			mu.Unlock()
			if phase == "already-exists" {
				if count != 0 || !strings.Contains(runErr.Error(), "bootstrap Secret already exists") {
					t.Fatal("existing Secret did not refuse before generation")
				}
				if _, err := os.Stat(receipt); !os.IsNotExist(err) {
					t.Fatal("preflight refusal created an installation attempt")
				}
				continueChecks := filepath.Join(root, "occ", "installation-credentials")
				if _, err := os.Stat(continueChecks); !os.IsNotExist(err) {
					t.Fatal("preflight refusal generated replacement credentials")
				}
				return
			}
			if secret == nil || count == 0 {
				t.Fatalf("no bootstrap Secret create observed: %v", runErr)
			}
			var selected installationBootstrapSecret
			if err := readInstallationRecord(receipt, "bootstrap-secret.json", &selected); err != nil {
				t.Fatal(err)
			}
			if selected.Name != "initial-access" || selected.PasswordKey != "login" || selected.ServiceKeyKey != "token" {
				t.Fatal("effective chart selection was not retained")
			}
			info, err := os.Stat(selected.InputDirectory)
			if err != nil || info.Mode().Perm() != 0700 {
				t.Fatal("recovery directory is not private")
			}
			for _, file := range []struct{ name, key string }{{"initial-admin-password", "login"}, {"initial-admin-service-key", "token"}} {
				path := filepath.Join(selected.InputDirectory, file.name)
				contents, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm() != 0600 {
					t.Fatal("recovery input is not private")
				}
				if secret["data"].(map[string]any)[file.key] != base64.StdEncoding.EncodeToString(contents) {
					t.Fatal("Secret differs from retained recovery inputs")
				}
				if strings.Contains(out+stderr, string(contents)) {
					t.Fatal("credential appeared in command output")
				}
				records, err := os.ReadDir(receipt)
				if err != nil {
					t.Fatal(err)
				}
				for _, record := range records {
					data, err := os.ReadFile(filepath.Join(receipt, record.Name()))
					if err != nil {
						t.Fatal(err)
					}
					if strings.Contains(string(data), string(contents)) {
						t.Fatal("credential appeared in receipt")
					}
				}
			}
			_, dispatchErr := os.Stat(filepath.Join(receipt, "dispatch.json"))
			_, confirmedErr := os.Stat(filepath.Join(receipt, "bootstrap-secret-result.json"))
			if phase == "confirmed" {
				if dispatchErr != nil || confirmedErr != nil {
					t.Fatal("confirmed Secret did not allow Helm dispatch")
				}
			} else if !os.IsNotExist(dispatchErr) || !os.IsNotExist(confirmedErr) {
				t.Fatal("unconfirmed Secret permitted Helm dispatch or confirmation")
			}
			if phase != "confirmed" {
				// Receipt-aware handoff must explain the additional write boundary without
				// requiring access to the protected recovery files or changing the cluster.
				handoff, _, _ := runHelp(t, "installation", "doctor", "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo", "--receipt", receipt)
				if !strings.Contains(handoff, "Bootstrap Secret: preparation or creation unconfirmed") {
					t.Fatal("handoff omitted unconfirmed bootstrap preparation")
				}
			}
		})
	}
}
