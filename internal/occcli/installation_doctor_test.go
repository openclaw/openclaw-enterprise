package occcli

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

// Use real kubectl against a local API, including its actual NotFound rendering.
// Assert the wire operation, not just the arguments given to a mock executable.
func TestInstallationDoctor(t *testing.T) {
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("requires kubectl")
	}
	const job = `{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"demo-initialization","namespace":"operations","uid":"id","labels":{"app.kubernetes.io/instance":"demo","app.kubernetes.io/name":"openclaw-enterprise","app.kubernetes.io/component":"initialization","app.kubernetes.io/managed-by":"Helm"},"annotations":{"helm.sh/hook":"pre-install,pre-upgrade"}},"spec":{"template":{"spec":{"initContainers":[{"name":"migration","args":["scripts/migrate-production.mjs"]}],"containers":[{"name":"bootstrap","args":["scripts/bootstrap-installation.mjs"]}]}}},"status":{"succeeded":1,"conditions":[{"type":"Complete","status":"True"}]}}`
	const migration = `"scripts/migrate-production.mjs"`
	failed := strings.Replace(strings.Replace(job, `"type":"Complete"`, `"type":"Failed"`, 1), `"succeeded":1`, `"failed":1`, 1)
	wrongRelease := strings.Replace(job, `io/instance":"demo"`, `io/instance":"other"`, 1)
	guarded := strings.Replace(job, migration, migration+`, "--expect-empty"`, 1)
	checkScript, err := os.ReadFile("../../deploy/helm/openclaw-enterprise/files/check-installation.mjs")
	if err != nil {
		t.Fatal(err)
	}
	checkArg, err := json.Marshal(string(checkScript))
	if err != nil {
		t.Fatal(err)
	}
	asUpgrade := func(job string) string {
		return strings.Replace(job, `"initContainers":[`, `"initContainers":[{"name":"installation-check","command":["node"],"args":["--input-type=module","-e",`+string(checkArg)+`]},`, 1)
	}
	withSidecar := func(body string) string {
		return strings.Replace(body, `"initContainers":[{`, `"initContainers":[{"restartPolicy":"Always",`, 1)
	}
	for _, tc := range []struct {
		name       string
		status     int
		body, want string
		success    bool
		uid        string
	}{
		{"install", 200, job, "Initialization Job (install hook): complete", true, ""},
		{"guarded-install", 200, guarded, "Initialization Job (install hook): complete", true, ""},
		{"upgrade", 200, asUpgrade(job), "upgrade hook): complete", true, ""},
		{"sidecar-migration", 200, withSidecar(job), "runs an initialization step as a sidecar", false, "id"},
		{"sidecar-upgrade-check", 200, withSidecar(asUpgrade(job)), "runs an initialization step as a sidecar", false, "id"},
		{"wrong-upgrade-check", 200, strings.Replace(asUpgrade(job), string(checkArg), `"process.exit(0)"`, 1), "steps do not match", false, ""},
		{"guarded-upgrade", 200, asUpgrade(guarded), "steps do not match", false, ""},
		{"extra-install-arg", 200, strings.Replace(guarded, `"--expect-empty"`, `"--expect-empty","unexpected"`, 1), "steps do not match", false, ""},
		{"wrong-release", 200, wrongRelease, "did not identify", false, "id"},
		{"deleting", 200, strings.Replace(job, `"uid":"id"`, `"uid":"id","deletionTimestamp":"now"`, 1), "did not identify", false, "id"},
		{"external-controller", 200, strings.Replace(job, `"spec":{"template"`, `"spec":{"managedBy":"example.invalid/handoff-readback","template"`, 1), "unsupported Job controller", false, "id"},
		{"no-condition", 200, strings.Replace(job, "Complete", "SuccessCriteriaMet", 1), "completion not established", false, ""},
		{"wrong-steps", 200, strings.Replace(job, "migrate-production.mjs", "sensitive-detail", 1), "do not match", false, ""},
		{"missing", 404, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"NotFound","code":404,"message":"jobs.batch \"demo-initialization\" not found"}`, "not found at the selected target", false, ""},
		{"login", 401, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Unauthorized","code":401,"message":"sensitive-detail"}`, "kubectl reported a login problem", false, ""},
		{"denied", 403, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","code":403,"message":"sensitive-detail"}`, "kubectl reported a refusal", false, ""},
		{"pinned-denied", 403, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","code":403,"message":"sensitive-detail"}`, "kubectl reported a refusal", false, "old"},
		{"server-marker", 500, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"InternalError","code":500,"message":"sensitive-detail; error: You must be logged in to the server; Error from server (Forbidden): refused"}`, "unknown. Could not read", false, ""},
		{"pinned-missing", 404, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"NotFound","code":404,"message":"jobs.batch \"demo-initialization\" not found"}`, "original outcome remains unknown", false, "old"},
		{"pinned", 200, job, "matches the recorded UID", true, "id"},
		{"replaced", 200, job, `expected UID "old", observed UID "id"`, false, "old"},
		{"replaced-wrong-release", 200, wrongRelease, `expected UID "old", observed UID "id"`, false, "old"},
		{"wrong-name", 200, strings.Replace(job, `"name":"demo-initialization"`, `"name":"other-initialization"`, 1), "did not identify", false, "old"},
		{"wrong-namespace", 200, strings.Replace(job, `"namespace":"operations"`, `"namespace":"other"`, 1), "did not identify", false, "old"},
		{"wrong-kind", 200, strings.Replace(job, `"kind":"Job"`, `"kind":"CronJob"`, 1), "did not identify", false, "old"},
		{"wrong-api-version", 200, strings.Replace(job, `"apiVersion":"batch/v1"`, `"apiVersion":"batch/v1beta1"`, 1), "did not identify", false, "old"},
		{"pinned-failed", 200, failed, "Initialization Job: failed", false, "id"},
		{"pinned-failing", 200, strings.Replace(failed, "Failed", "FailureTarget", 1), "completion not established", false, "id"},
		{"pinned-active-failed", 200, strings.Replace(failed, `"failed":1`, `"failed":1,"active":1`, 1), "completion not established", false, "id"},
		{"pinned-terminating-failed", 200, strings.Replace(failed, `"failed":1`, `"failed":1,"terminating":1`, 1), "completion not established", false, "id"},
		{"conflicting-terminal-conditions", 200, strings.Replace(job, `"conditions":[`, `"conditions":[{"type":"Failed","status":"True"},`, 1), "completion not established", false, "id"},
		{"suspended-complete", 200, strings.Replace(job, `"conditions":[`, `"conditions":[{"type":"Suspended","status":"True"},`, 1), "completion not established", false, "id"},
		{"unpinned-failed", 200, failed, "Initialization Job: failed", false, ""},
		{"replaced-failed", 200, failed, "original outcome remains unknown", false, "old"},
		{"unsafe-uid-failed", 200, strings.Replace(failed, `"uid":"id"`, `"uid":"a,b"`, 1), "Initialization Job: failed", false, "a,b"},
		{"no-uid", 200, strings.Replace(job, `"uid":"id",`, "", 1), "did not identify", false, "old"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				path := r.URL.Path
				if r.Method == http.MethodGet && serveJobDiscovery(w, path) {
					return
				}
				if tc.status == http.StatusNotFound && r.Method == http.MethodGet && path == "/api/v1/namespaces/operations" {
					// kubectl may check for the namespace; the reader need not have that access.
					http.Error(w, "Forbidden", http.StatusForbidden)
					return
				}
				requests.Add(1)
				if r.Method != "GET" || r.URL.RequestURI() != "/apis/batch/v1/namespaces/operations/jobs/demo-initialization" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer s.Close()
			config := installationDoctorKubeconfig(t, s.URL)
			for _, action := range []string{"doctor", "plan"} {
				requests.Store(0)
				args := []string{"installation", action, "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo"}
				if tc.uid != "" {
					args = append(args, "--expect-job-uid", tc.uid)
				}
				out, stderr, err := runHelp(t, args...)
				var exit *ExitStatusError
				if (err == nil) != tc.success || (!tc.success && (!errors.As(err, &exit) || exit.Code != 1)) ||
					stderr != "" || requests.Load() != 1 || strings.Contains(out, "sensitive-detail") {
					t.Errorf("out=%s stderr=%s err=%v requests=%d", out, stderr, err, requests.Load())
				}
				if tc.status == 401 || tc.status == 403 || tc.status == 500 {
					for _, unwanted := range []string{"obtain permission", "first-install intent", "not found at the selected target"} {
						if strings.Contains(out, unwanted) {
							t.Errorf("unexpected %q in %s", unwanted, out)
						}
					}
				}
				expected := []string{tc.want, "Do not replay", "removal unknown", "not qualified"}
				if action == "plan" {
					first := map[string]string{"login": "1. Confirm the cluster target", "denied": "1. Confirm the cluster target and intended reader", "missing": "first-install intent", "install": "1. Establish whether", "guarded-install": "1. Establish whether", "upgrade": "1. Establish whether", "pinned": "1. Continue from the completed migration and bootstrap for the recorded Job", "replaced": "1. Recover the original installation record", "pinned-missing": "1. Recover the original installation record", "pinned-denied": "1. Confirm the cluster target and intended reader", "server-marker": "1. Confirm the cluster target"}[tc.name]
					if tc.name == "replaced-wrong-release" {
						first = "1. Recover the original installation record"
					}
					expected = []string{tc.want, first, "2. If an API operation was attempted", "3. Verify temporary access", "4. Qualify useful work"}
					switch tc.status {
					case 401:
						expected = append(expected, "separately authorized read-only session")
					case 403:
						expected = append(expected, "Do not restore temporary privilege or request broader access")
					}
				}
				wantLookup := action == "plan" && tc.name == "pinned-failed"
				wantPodGuidance := action == "plan" && (tc.name == "pinned-failed" || tc.name == "unsafe-uid-failed")
				if strings.Contains(out, "Ask an operator who can already list Pods") != wantPodGuidance {
					t.Errorf("want operator Pod guidance %v in %s", wantPodGuidance, out)
				}
				if strings.Contains(out, "get pods") != wantLookup {
					t.Errorf("want operator Pod lookup %v in %s", wantLookup, out)
				}
				if wantLookup && (strings.Contains(out, config) || strings.Contains(out, "--context=read") || strings.Contains(out, "--context='read'")) {
					t.Errorf("operator Pod lookup includes the Job reader's target: %s", out)
				}
				if tc.success {
					expected = append(expected, `operations/demo-initialization, UID "id"`)
					// A completed hook can precede a failed Helm release. Its named Job
					// cannot prove the release or its API and worker workloads are ready.
					expected = append(expected, "This Job does not establish Helm release status", "whether the API and worker Deployments rolled out and are ready")
					if action == "plan" && tc.uid == "id" {
						expected = append(expected, "Ask the release operator to check the Helm release status", "whether its API and worker Deployments rolled out and are ready", "Do not rerun initialization")
					}
				}
				for _, want := range expected {
					if !strings.Contains(out, want) {
						t.Errorf("want %q in %s", want, out)
					}
				}
			}
		})
	}

	t.Run("kubeconfig replacement does not split cluster path from credential", func(t *testing.T) {
		// A gateway serving different clusters must see the selected cluster's
		// path and credential together, including on discovery requests.
		const prefix = "/k8s/clusters/selected%20cluster"
		const jobPath = "/apis/batch/v1/namespaces/operations/jobs/demo-initialization"
		const tlsName = "gateway.example.com" // covered by the httptest certificate
		var requests atomic.Int32
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path, selected := strings.CutPrefix(r.URL.EscapedPath(), prefix)
			if r.Method != http.MethodGet || !selected || r.Header.Get("Authorization") != "Bearer selected-reader" {
				t.Errorf("wrong target or credential for %s %s", r.Method, r.URL.RequestURI())
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if serveJobDiscovery(w, path) {
				return
			}
			requests.Add(1)
			if r.TLS.ServerName != tlsName {
				t.Errorf("TLS server name = %q; want %q", r.TLS.ServerName, tlsName)
			}
			if path != jobPath {
				t.Errorf("read %s %s; want GET %s", r.Method, r.URL.RequestURI(), prefix+jobPath)
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, job)
		}))
		defer server.Close()

		ca := filepath.Join(t.TempDir(), "ca.pem")
		if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
			t.Fatal(err)
		}
		oldCluster := "server: " + server.URL + "/previous"
		newCluster := "server: " + server.URL + prefix + "/"
		caField, tlsField := "certificate-authority: "+ca, "tls-server-name: "+tlsName
		config := installationReaderKubeconfig(t, "token: previous-reader", oldCluster, caField, tlsField)
		replacement := installationReaderKubeconfig(t, "token: selected-reader", newCluster, caField, tlsField)

		// Replace the config just before the get. A separate preliminary config
		// read would select /previous and then send selected-reader there.
		kubectl, err := exec.LookPath("kubectl")
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		shim := `#!/bin/sh
case " $* " in *" get "*) mv "$REPLACEMENT_CONFIG" "$ACTIVE_CONFIG" || exit 1;; esac
exec "$REAL_KUBECTL" "$@"
`
		if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(shim), 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("REAL_KUBECTL", kubectl)
		t.Setenv("REPLACEMENT_CONFIG", replacement)
		t.Setenv("ACTIVE_CONFIG", config)
		t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		out, _, err := runHelp(t, "installation", "plan", "--kubeconfig", config, "--context", "read",
			"--kube-namespace", "operations", "--release", "demo", "--expect-job-uid", "id")
		if err != nil || requests.Load() != 1 || !strings.Contains(out, "matches the recorded UID") {
			t.Fatalf("error=%v requests=%d output=%s", err, requests.Load(), out)
		}
	})

	t.Run("credential plugin and Job use the same cluster path", func(t *testing.T) {
		const prefix = "/clusters/selected"
		const jobPath = "/apis/batch/v1/namespaces/operations/jobs/demo-initialization"
		// Permit API discovery metadata and exactly one named Job. In particular,
		// a request to the gateway root or an attempt to list Jobs fails this test.
		var reads atomic.Int32
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path, routed := strings.CutPrefix(r.URL.Path, prefix)
			if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer fixture" || !routed {
				t.Errorf("unexpected %s %s", r.Method, r.URL.RequestURI())
				http.NotFound(w, r)
				return
			}
			if serveJobDiscovery(w, path) {
				return
			}
			if path != jobPath {
				t.Errorf("unexpected resource %s", path)
				http.NotFound(w, r)
				return
			}
			reads.Add(1)
			fmt.Fprint(w, job)
		}))
		defer server.Close()

		// A path-scoped credential must not be requested for the bare gateway.
		// Fail before issuing it unless kubectl tells the plugin the full server URL.
		serverURL := server.URL + prefix
		plugin := filepath.Join(t.TempDir(), "credential")
		script := fmt.Sprintf(`#!/bin/sh
case "$KUBERNETES_EXEC_INFO" in
  *'"server":"%s"'*) ;;
  *) echo "wrong cluster in credential request" >&2; exit 1 ;;
esac
echo '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"fixture"}}'
`, serverURL)
		if err := os.WriteFile(plugin, []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
		user := fmt.Sprintf("exec: {command: %q, apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never, provideClusterInfo: true}", plugin)
		ca := filepath.Join(t.TempDir(), "ca.pem")
		if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
			t.Fatal(err)
		}
		config := installationReaderKubeconfig(t, user, "server: "+serverURL, "certificate-authority: "+ca)
		out, _, err := runHelp(t, "installation", "plan", "--kubeconfig", config, "--context", "read",
			"--kube-namespace", "operations", "--release", "demo", "--expect-job-uid", "id")
		if err != nil || reads.Load() != 1 || !strings.Contains(out, "matches the recorded UID") {
			t.Fatalf("error=%v Job reads=%d output=%s", err, reads.Load(), out)
		}
	})

	t.Run("rate-limited read observes replacement", func(t *testing.T) {
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet && serveJobDiscovery(w, r.URL.Path) {
				return
			}
			if r.Method != http.MethodGet || r.URL.RequestURI() != "/apis/batch/v1/namespaces/operations/jobs/demo-initialization" {
				t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
			}
			w.Header().Set("Content-Type", "application/json")
			if requests.Add(1) == 1 {
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(http.StatusTooManyRequests)
				fmt.Fprint(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"TooManyRequests","message":"too many requests","details":{"retryAfterSeconds":1},"code":429}`)
				return
			}
			fmt.Fprint(w, strings.Replace(job, `"uid":"id"`, `"uid":"replacement"`, 1))
		}))
		defer server.Close()

		out, stderr, err := runHelp(t, "installation", "plan", "--kubeconfig", installationDoctorKubeconfig(t, server.URL),
			"--context", "read", "--kube-namespace", "operations", "--release", "demo", "--expect-job-uid", "id", "--timeout-seconds", "5")
		if err == nil || stderr != "" || requests.Load() < 2 {
			t.Fatalf("out=%s stderr=%s err=%v requests=%d", out, stderr, err, requests.Load())
		}
		for _, want := range []string{`expected UID "id", observed UID "replacement"`, "original outcome remains unknown", "1. Recover the original installation record"} {
			if !strings.Contains(out, want) {
				t.Errorf("want %q in %s", want, out)
			}
		}
	})
}

// Serve only the API metadata kubectl needs to locate batch/v1 Jobs.
// The test's resource handler must account for every other request.
func serveJobDiscovery(w http.ResponseWriter, path string) bool {
	w.Header().Set("Content-Type", "application/json")
	body, ok := map[string]string{
		"/api":           `{"kind":"APIVersions","apiVersion":"v1","versions":["v1"]}`,
		"/api/v1":        `{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"v1","resources":[]}`,
		"/apis":          `{"kind":"APIGroupList","apiVersion":"v1","groups":[{"name":"batch","versions":[{"groupVersion":"batch/v1","version":"v1"}]}]}`,
		"/apis/batch/v1": `{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"batch/v1","resources":[{"name":"jobs","kind":"Job","namespaced":true,"verbs":["get"]}]}`,
	}[path]
	if ok {
		fmt.Fprint(w, body)
	}
	return ok
}

func installationDoctorKubeconfig(t *testing.T, serverURL string, clusterFields ...string) string {
	t.Helper()
	return installationReaderKubeconfig(t, "token: fixture", append([]string{"server: " + serverURL}, clusterFields...)...)
}

func installationReaderKubeconfig(t *testing.T, user string, clusterFields ...string) string {
	t.Helper()
	config := filepath.Join(t.TempDir(), "kubeconfig")
	contents := fmt.Sprintf(`apiVersion: v1
kind: Config
clusters: [{name: test, cluster: {%s}}]
contexts: [{name: read, context: {cluster: test, user: fixture}}]
users: [{name: fixture, user: {%s}}]
`, strings.Join(clusterFields, ", "), user)
	if err := os.WriteFile(config, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	return config
}

func TestInstallationDoctorRejectsEmptyExpectedUID(t *testing.T) {
	_, _, err := runHelp(t, "installation", "doctor", "--kubeconfig", "unused", "--context", "unused", "--kube-namespace", "demo", "--release", "demo", "--expect-job-uid=")
	if err == nil || !strings.Contains(err.Error(), "must not be empty") {
		t.Fatalf("error = %v", err)
	}
}

func TestReportedKubectlReadProblemRequiresAnUnwrappedDiagnostic(t *testing.T) {
	for _, tc := range []struct {
		name, diagnostic string
		want             initializationState
	}{
		{"login", "error: You must be logged in to the server (details)\n", initializationLoginReported},
		{"refusal", "Error from server (Forbidden): details\n", initializationRefusalReported},
		{"warning", "Warning: unrelated\nError from server (Forbidden): details\n", initializationUnreadable},
		{"wrapped", "error: exec plugin failed: error: You must be logged in to the server (details)\n", initializationUnreadable},
		{"localized", "Error del servidor (Forbidden): details\n", initializationUnreadable},
		{"embedded", "Error from server (InternalError): Error from server (Forbidden): details\n", initializationUnreadable},
		{"empty-refusal", "Error from server (Forbidden): \n", initializationUnreadable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := reportedKubectlReadProblem(tc.diagnostic); got != tc.want {
				t.Errorf("classification = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestInstallationDoctorIgnoresIncompleteKubectlDiagnostics(t *testing.T) {
	dir := t.TempDir()
	kubectl := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(kubectl, []byte("#!/bin/sh\nprintf '%s\\n' 'Error from server (Forbidden): details' >&2\nexit 2\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	result := readInitialization(context.Background(), "unused", "read", "operations", "demo-initialization", "demo", "")
	if result.state != initializationUnreadable || !strings.Contains(result.message, "unknown. Could not read") || strings.Contains(result.message, "refusal") {
		t.Fatalf("result=%+v", result)
	}

	// An exact-looking NotFound line cannot establish absence when the other
	// output stream exceeded the read bound.
	if err := os.WriteFile(kubectl+".data", bytes.Repeat([]byte("x"), (4<<20)+1), 0600); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nprintf '%s\\n' 'Error from server (NotFound): jobs.batch \"demo-initialization\" not found' >&2\ncat \"$0.data\"\ntouch \"$0.done\"\nexit 1\n"
	if err := os.WriteFile(kubectl, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	result = readInitialization(context.Background(), "unused", "read", "operations", "demo-initialization", "demo", "")
	if _, err := os.Stat(kubectl + ".done"); err != nil {
		t.Fatalf("kubectl fixture did not finish: %v", err)
	}
	if result.state != initializationUnreadable || !strings.Contains(result.message, "unknown. Could not read") || strings.Contains(result.message, "not found at the selected target") {
		t.Fatalf("result=%+v", result)
	}
}

func TestFailedJobPodLookupShellArguments(t *testing.T) {
	config, kctx := "/path/with space/operator's $(printf injected) config", "reader '$USER; echo injected"
	guidance := failedJobPodLookup("operations", "abc-123")
	lines := strings.Split(guidance, "\n")
	if len(lines) != 3 {
		t.Fatalf("missing command in %q", guidance)
	}
	// Ask the shell how it parsed the displayed command. Do not run kubectl.
	script := `kubectl() { printf '%s\n' "$@"; }; ` + lines[1]
	run := func(env ...string) ([]byte, error) {
		cmd := exec.Command("sh", "-c", script)
		cmd.Env = append([]string{}, env...)
		return cmd.Output()
	}
	out, err := run("POD_READER_KUBECONFIG="+config, "POD_READER_CONTEXT="+kctx)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSuffix(string(out), "\n"), "\n")
	want := []string{"--kubeconfig=" + config, "--context=" + kctx, "--namespace=operations",
		"get", "pods", "--selector=batch.kubernetes.io/controller-uid=abc-123", "-o",
		`custom-columns=POD:.metadata.name,CONTROLLER_UID:.metadata.ownerReferences[?(@.controller==true)].uid,MIGRATION_EXIT_CODE:.status.initContainerStatuses[?(@.name=="migration")].state.terminated.exitCode,BOOTSTRAP_EXIT_CODE:.status.containerStatuses[?(@.name=="bootstrap")].state.terminated.exitCode`}
	if !slices.Equal(got, want) {
		t.Fatalf("arguments: %q, want %q", got, want)
	}
	for _, tc := range []struct {
		env  []string
		want string
	}{
		{[]string{"POD_READER_CONTEXT=" + kctx}, "POD_READER_KUBECONFIG"},
		{[]string{"POD_READER_KUBECONFIG=", "POD_READER_CONTEXT=" + kctx}, "POD_READER_KUBECONFIG"},
		{[]string{"POD_READER_KUBECONFIG=" + config}, "POD_READER_CONTEXT"},
		{[]string{"POD_READER_KUBECONFIG=" + config, "POD_READER_CONTEXT="}, "POD_READER_CONTEXT"},
	} {
		out, err := run(tc.env...)
		var exit *exec.ExitError
		if !errors.As(err, &exit) || len(out) != 0 || !strings.Contains(string(exit.Stderr), tc.want) {
			t.Errorf("env=%q stdout=%q err=%v; want %s error before kubectl", tc.env, out, err, tc.want)
		}
	}
}
