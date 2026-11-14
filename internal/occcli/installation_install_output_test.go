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
	for _, phase := range []struct {
		name            string
		failNotice      bool
		failResult      bool
		failHelm        bool
		templateFailure string
	}{
		{name: "healthy"},
		{name: "healthy-inherited-stderr"},
		{name: "intent", failNotice: true},
		{name: "result", failResult: true},
		{name: "helm-failed", failHelm: true},
		{name: "stock-suffix-refusal", templateFailure: "stock"},
		{name: "template-canary-refusal", templateFailure: "canary"},
		{name: "template-overflow", templateFailure: "overflow"},
		{name: "helm-failed-result", failHelm: true, failResult: true},
	} {
		t.Run(phase.name, func(t *testing.T) {
			for _, setting := range os.Environ() {
				key, _, _ := strings.Cut(setting, "=")
				if strings.HasPrefix(key, "HELM_KUBE") || key == "HELM_DRIVER" {
					t.Setenv(key, "")
				}
			}
			root := t.TempDir()
			if phase.name == "healthy-inherited-stderr" {
				for _, tool := range []string{"/bin/sh", "/bin/sleep"} {
					if _, err := os.Stat(tool); err != nil {
						t.Skip("requires " + tool)
					}
				}
				helm, err := exec.LookPath("helm")
				if err != nil {
					t.Fatal(err)
				}
				t.Setenv("TEST_REAL_HELM", helm)
				// A child retaining stderr must not turn a successful real Helm
				// install into an unknown receipt when Go stops draining the pipe.
				shim := "#!/bin/sh\nif [ \"$1\" = install ]; then /bin/sleep 3 >&2 & fi\nexec \"$TEST_REAL_HELM\" \"$@\"\n"
				if err := os.WriteFile(filepath.Join(root, "helm"), []byte(shim), 0700); err != nil {
					t.Fatal(err)
				}
				t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
			}
			receipt := filepath.Join(root, "receipt")
			var mu sync.Mutex
			var releases []json.RawMessage
			creates, updates := 0, 0
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
					if r.Method == http.MethodPost {
						creates++
					} else {
						updates++
					}
					mu.Unlock()
					if r.Method == http.MethodPost {
						var dispatch map[string]string
						if err := readInstallationRecord(receipt, "dispatch.json", &dispatch); err != nil || dispatch["outcome"] != "unknown" {
							t.Errorf("original dispatch marker before Helm create: %v, err=%v", dispatch, err)
						}
						// A failed response after storage makes the real Helm process
						// exit nonzero while retaining evidence of the initial dispatch.
						if phase.failHelm {
							w.WriteHeader(http.StatusInternalServerError)
							fmt.Fprint(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"InternalError","message":"release create response failed","code":500}`)
							return
						}
					}
					w.Header().Set("Content-Type", r.Header.Get("Content-Type"))
					if r.Method == http.MethodPost {
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
			const canary = "private-template-canary-7b1d"
			if phase.templateFailure == "stock" {
				// Keep the stock chart intact; change only the Console host so the
				// chart itself rejects the shared browser-session suffix.
				chart = "../../deploy/helm/openclaw-enterprise"
				original, err := os.ReadFile("../../deploy/examples/production/values.yaml")
				if err != nil {
					t.Fatal(err)
				}
				rejected := strings.ReplaceAll(string(original), "https://console.oce.example.internal", "https://"+canary+".unrelated.invalid")
				if rejected == string(original) {
					t.Fatal("stock fixture host was not replaced")
				}
				if err := os.WriteFile(values, []byte(rejected), 0600); err != nil {
					t.Fatal(err)
				}
			} else if phase.templateFailure != "" {
				if err := os.Mkdir(filepath.Join(chart, "templates"), 0700); err != nil {
					t.Fatal(err)
				}
				template := `{{ fail .Values.privateDiagnostic }}`
				if phase.templateFailure == "overflow" {
					// Excess diagnostics must be drained without changing Helm's failure
					// or treating a partial message as evidence for guidance.
					template = `{{ fail (repeat 200000 .Values.privateDiagnostic) }}`
				}
				if err := os.WriteFile(filepath.Join(chart, "templates", "refusal.yaml"), []byte(template), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(values, []byte("privateDiagnostic: "+canary+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var outputAttempt, stderr bytes.Buffer
			var output io.Writer = &outputAttempt
			failure := errors.New("synthetic output delivery failure")
			if phase.failNotice || phase.failResult {
				remaining := 0
				if phase.failResult {
					remaining = len(fmt.Sprintf("Installation intent persisted in %s. An interrupted dispatch remains unknown; do not repeat install.\n", receipt))
				}
				// Record the bytes before the failing writer so the dual-failure case
				// also proves that the command attempted to report the outcome.
				output = io.MultiWriter(&outputAttempt, &handoffFailingWriter{remaining: remaining, err: failure})
			}
			cmd := New(output, &stderr)
			cmd.SetArgs([]string{"installation", "install", "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo", "--chart", chart, "--values", values, "--receipt", receipt})
			err := cmd.ExecuteContext(t.Context())
			wantOutcome := "succeeded"
			switch {
			case phase.failHelm || phase.templateFailure != "":
				wantOutcome = "failed"
				var status *ExitStatusError
				if !errors.As(err, &status) || status.Code != 1 {
					t.Errorf("error=%v, want Helm ExitStatusError with code 1", err)
				}
			case phase.failNotice || phase.failResult:
				if !errors.Is(err, failure) {
					t.Errorf("error=%v, want the exact output delivery failure", err)
				}
			default:
				if err != nil {
					t.Errorf("healthy install: err=%v stderr=%q", err, stderr.String())
				}
			}
			mu.Lock()
			createCount, updateCount := creates, updates
			mu.Unlock()
			if phase.failNotice {
				if createCount != 0 || updateCount != 0 {
					t.Errorf("Helm attempted release writes after intent output failed: creates=%d updates=%d", createCount, updateCount)
				}
				if _, err := os.Stat(filepath.Join(receipt, "dispatch.json")); !os.IsNotExist(err) {
					t.Errorf("failed intent output left dispatch evidence: %v", err)
				}
				if _, err := os.Stat(filepath.Join(receipt, "intent.json")); err != nil {
					t.Errorf("original persisted intent was lost: %v", err)
				}
			} else {
				wantCreates := 1
				if phase.templateFailure != "" {
					wantCreates = 0
				}
				if createCount != wantCreates || (phase.templateFailure != "" && updateCount != 0) {
					t.Errorf("Helm release writes: creates=%d updates=%d, want %d creates", createCount, updateCount, wantCreates)
				}
				var dispatch map[string]string
				if err := readInstallationRecord(receipt, "dispatch.json", &dispatch); err != nil || dispatch["outcome"] != "unknown" {
					t.Errorf("stored original dispatch marker: %v, err=%v", dispatch, err)
				}
				if outcome, err := readInstallationOutcome(receipt); err != nil || outcome != wantOutcome {
					t.Errorf("stored Helm outcome=%q err=%v, want %q", outcome, err, wantOutcome)
				}
				if !strings.Contains(outputAttempt.String(), "Helm outcome: "+wantOutcome+".") {
					t.Errorf("missing reported Helm outcome %q in %q", wantOutcome, outputAttempt.String())
				}
			}
			text := outputAttempt.String() + stderr.String()
			if strings.Contains(text, canary) {
				t.Fatal("private template value escaped to output")
			}
			if phase.templateFailure == "" || phase.templateFailure == "overflow" {
				if strings.Contains(text, "helm template") {
					t.Fatal("unrelated outcome gained template guidance")
				}
				if phase.templateFailure == "" {
					return
				}
			}
			if phase.templateFailure != "overflow" {
				for _, guidance := range []string{"Helm reported a template validation failure", "helm template", "protected", "does not establish", "unknown"} {
					if !strings.Contains(text, guidance) {
						t.Errorf("missing guidance %q", guidance)
					}
				}
			}
			if phase.templateFailure == "stock" && !strings.Contains(text, "auth.baseUrl and agentNativeAdmin.domain must share a non-public DNS suffix") {
				t.Error("stock suffix refusal lacks actionable settings")
			}
			if phase.templateFailure == "canary" && strings.Contains(text, "auth.baseUrl") {
				t.Error("unrelated template refusal gained suffix guidance")
			}
			// Recovery reads must neither rewrite the receipt nor infer original Job
			// completion from Helm's diagnostic or the fixture's absent Job.
			entries, err := os.ReadDir(receipt)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 3 {
				t.Fatalf("unexpected receipt files: %d", len(entries))
			}
			before := make(map[string]string)
			for _, entry := range entries {
				raw, err := os.ReadFile(filepath.Join(receipt, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				if bytes.Contains(raw, []byte(canary)) || bytes.Contains(raw, []byte("execution error")) {
					t.Fatal("raw diagnostic persisted")
				}
				before[entry.Name()] = string(raw)
			}
			for _, action := range []string{"doctor", "plan"} {
				out, errout, err := runHelp(t, "installation", action, "--receipt", receipt, "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo")
				if err == nil || !strings.Contains(out, "Helm outcome: failed") || !strings.Contains(out, "original") || !strings.Contains(out, "unknown") || strings.Contains(out+errout, canary) {
					t.Fatalf("%s did not preserve failed Helm and unknown original Job", action)
				}
			}
			for name, original := range before {
				raw, err := os.ReadFile(filepath.Join(receipt, name))
				if err != nil || string(raw) != original {
					t.Fatal("recovery changed receipt")
				}
			}
			// A lost result still means unknown, even after a template refusal.
			if err := os.Remove(filepath.Join(receipt, "helm-result.json")); err != nil {
				t.Fatal(err)
			}
			out, _, err := runHelp(t, "installation", "plan", "--receipt", receipt, "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo")
			if err == nil || !strings.Contains(out, "Helm outcome: unknown") {
				t.Fatal("missing result lost unknown outcome")
			}

		})
	}
}
