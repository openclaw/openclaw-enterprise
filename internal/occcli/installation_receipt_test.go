package occcli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestInstallationReceiptImmutableRecords(t *testing.T) {
	directory := t.TempDir()
	original := map[string]string{"outcome": "unknown"}
	if err := writeInstallationRecord(directory, "dispatch.json", original); err != nil {
		t.Fatal(err)
	}
	if err := writeInstallationRecord(directory, "dispatch.json", map[string]string{"outcome": "succeeded"}); err == nil {
		t.Fatal("overwrote original dispatch evidence")
	}
	var observed map[string]string
	if err := readInstallationRecord(directory, "dispatch.json", &observed); err != nil {
		t.Fatal(err)
	}
	if observed["outcome"] != "unknown" {
		t.Fatalf("changed evidence: %v", observed)
	}
}

func TestInstallationReceiptTargetRefusalBeforeRead(t *testing.T) {
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("requires kubectl")
	}
	// The caller's trusted context now resolves to another cluster. Receipt
	// validation must reject it before sending even a named-Job read there.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request to changed target: %s", r.URL.Path)
	}))
	defer server.Close()
	originalConfig := installationDoctorKubeconfig(t, server.URL+"/clusters/first")
	_, originalCluster, err := snapshotInstallationConfig(context.Background(), originalConfig, "read", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := installationDoctorKubeconfig(t, server.URL+"/clusters/second")
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	intent := installationIntent{Version: 1, Operation: "helm-install", Attempt: strings.Repeat("a", 64), ClusterSHA256: originalCluster, Namespace: "operations", Release: "demo", ChartSHA256: strings.Repeat("c", 64), ValuesSHA256: strings.Repeat("d", 64)}
	if err := writeInstallationRecord(directory, "intent.json", intent); err != nil {
		t.Fatal(err)
	}
	out, _, err := runHelp(t, "installation", "doctor", "--kubeconfig", config, "--context", "read", "--kube-namespace", "operations", "--release", "demo", "--receipt", directory)
	if err == nil || !strings.Contains(err.Error(), "does not match") || out != "" {
		t.Fatalf("out=%q error=%v", out, err)
	}
	// Snapshotting retains authorization inputs only in a private temporary
	// file; its durable identity excludes the chosen reader's credentials.
	work := t.TempDir()
	snapshot, first, err := snapshotInstallationConfig(context.Background(), config, "read", work)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	document["users"] = []any{map[string]any{"name": "fixture", "user": map[string]any{"token": "replacement-reader"}}}
	changed, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(config, changed, 0600); err != nil {
		t.Fatal(err)
	}
	_, second, err := snapshotInstallationConfig(context.Background(), config, "read", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("changing the authorized reader changed cluster identity")
	}
}

func TestInstallRefusesHelmTargetOverride(t *testing.T) {
	// A shell setting must never send even the release lookup to a different
	// API server, or disclose either the value or Helm diagnostics.
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("requires helm")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected Helm request to overridden target: %s", r.URL.Path)
	}))
	defer server.Close()
	t.Setenv("HELM_KUBEAPISERVER", server.URL)
	config := installationDoctorKubeconfig(t, server.URL+"/selected")
	receipt := filepath.Join(t.TempDir(), "receipt")
	chart := "../../deploy/helm/openclaw-enterprise"
	out, stderr, err := runHelp(t, "installation", "install", "--kubeconfig", config, "--context", "read",
		"--release", "demo", "--kube-namespace", "operations", "--receipt", receipt,
		"--chart", chart, "--values", filepath.Join(chart, "values.yaml"))
	if err == nil || !strings.Contains(err.Error(), "Helm Kubernetes overrides") ||
		strings.Contains(err.Error(), server.URL) || out != "" || stderr != "" {
		t.Fatalf("unexpected override refusal: stdout=%q stderr=%q err=%v", out, stderr, err)
	}
	if _, err := os.Stat(receipt); !os.IsNotExist(err) {
		t.Fatalf("expected no attempt receipt, got %v", err)
	}
}

func TestInstallLegacyBootstrapValuesNotice(t *testing.T) {
	for _, tool := range []string{"helm", "kubectl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("requires " + tool)
		}
	}
	current, err := os.ReadFile("../../deploy/examples/production/values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	const privateValue = "fixture-private-pvc-name"
	for _, tc := range []struct {
		name, mode, addition, extraDocument, preflightError string
		warn, missingSelection                              bool
	}{
		{name: "generated mixed values", mode: "generate", addition: "  password: {claimName: " + privateValue + "}\n  serviceKey: {}\n", warn: true},
		{name: "existing mixed values", mode: "existing", addition: "  'serviceKey': {fileName: " + privateValue + "}\n", warn: true},
		{name: "existing second document", mode: "existing", extraDocument: "\n---\nbootstrap: {password: {claimName: " + privateValue + "}}\n", warn: true},
		{name: "existing current values", mode: "existing", addition: "  # password: {claimName: " + privateValue + "}\n"},
		{name: "existing malformed values", mode: "existing", addition: "  password: [" + privateValue + "\n", preflightError: "cannot validate the selected chart and values offline"},
		{name: "generate requires Secret selection", mode: "generate", addition: "  password: {claimName: " + privateValue + "}\n", preflightError: "Check bootstrap.credentials.secretName", warn: true, missingSelection: true},
		{name: "existing requires Secret selection", mode: "existing", addition: "  serviceKey: {fileName: " + privateValue + "}\n", preflightError: "Check bootstrap.credentials.secretName", warn: true, missingSelection: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			receipt := filepath.Join(root, "receipt")
			t.Setenv("XDG_STATE_HOME", root)
			var announced atomic.Bool
			var requests atomic.Int32
			// Valid inputs reach a denied release lookup after the warning.
			// Invalid inputs must stop before even querying this API.
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodGet || announced.Load() != tc.warn {
					t.Error("installation reached the API before issuing the expected notice")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				_, _ = io.WriteString(w, `{"kind":"Status","apiVersion":"v1","reason":"Forbidden","code":403}`)
			}))
			defer server.Close()
			values := filepath.Join(root, "values.yaml")
			content := strings.Replace(string(current), "\nbootstrap:\n", "\nbootstrap:\n"+tc.addition, 1) + tc.extraDocument
			if tc.missingSelection {
				withoutSelection := strings.Replace(content, "  credentials:\n    secretName: occ-bootstrap-credentials\n", "", 1)
				if withoutSelection == content {
					t.Fatal("shipped example does not contain the expected Secret selection")
				}
				content = withoutSelection
			}
			if err := os.WriteFile(values, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			var stdout, stderr strings.Builder
			cmd := New(&stdout, installationNoticeWriter(func(data []byte) (int, error) {
				announced.Store(true)
				return stderr.Write(data)
			}))
			chart := "../../deploy/helm/openclaw-enterprise"
			if tc.mode == "generate" && !tc.missingSelection {
				// Require the same attempt override that Helm install receives.
				custom := filepath.Join(root, "chart")
				if err := os.CopyFS(custom, os.DirFS(chart)); err != nil {
					t.Fatal(err)
				}
				chart = custom
				hook := filepath.Join(chart, "templates", "check-attempt.yaml")
				const check = `{{ if not .Values.installation.attemptId }}{{ fail "missing attempt" }}{{ end }}`
				if err := os.WriteFile(hook, []byte(check), 0600); err != nil {
					t.Fatal(err)
				}
			}
			cmd.SetArgs([]string{"installation", "install", "--bootstrap-credentials", tc.mode,
				"--kubeconfig", installationDoctorKubeconfig(t, server.URL), "--context", "read",
				"--release", "demo", "--kube-namespace", "operations", "--receipt", receipt,
				"--chart", chart, "--values", values})
			err := cmd.Execute()
			if tc.preflightError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.preflightError) || requests.Load() != 0 {
					t.Fatalf("expected offline refusal before any API requests, got %v with %d requests", err, requests.Load())
				}
			} else if err == nil || !strings.Contains(err.Error(), "cannot establish that the Helm release is unused") || requests.Load() == 0 {
				t.Fatalf("expected the ordinary Helm release check to refuse the install, got %v", err)
			}
			if tc.warn {
				for _, guidance := range []string{"bootstrap.password", "bootstrap.serviceKey", "do not write credential files", "occ installation migrate-values --help"} {
					if !strings.Contains(stderr.String(), guidance) {
						t.Errorf("warning omits %q", guidance)
					}
				}
			} else if stderr.Len() != 0 {
				t.Error("unexpected bootstrap warning")
			}
			if strings.Contains(stdout.String()+stderr.String()+err.Error(), privateValue) {
				t.Error("installation disclosed a values file entry")
			}
			for _, path := range []string{receipt, filepath.Join(root, "occ")} {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("refused install left installation state at %s: %v", path, err)
				}
			}
			if retained, err := os.ReadFile(values); err != nil || string(retained) != content {
				t.Fatal("installer changed the original values")
			}
		})
	}
}

func TestEmptyInstallationReceiptCannotSelectUnboundDoctor(t *testing.T) {
	out, _, err := runHelp(t, "installation", "doctor", "--kubeconfig", "unused", "--context", "read",
		"--kube-namespace", "operations", "--release", "demo", "--receipt=")
	if err == nil || !strings.Contains(err.Error(), "--receipt") || out != "" {
		t.Fatalf("empty receipt: stdout=%q err=%v", out, err)
	}
}

func TestInstallationFrozenChartDoesNotFollowChangedSources(t *testing.T) {
	source := t.TempDir()
	path := filepath.Join(source, "Chart.yaml")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	frozen, _, err := snapshotInstallationChart(source, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(frozen, "Chart.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "original" {
		t.Fatal("frozen chart followed a changed input")
	}
	if err = os.Symlink(path, filepath.Join(source, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, _, err = snapshotInstallationChart(source, t.TempDir()); err == nil {
		t.Fatal("accepted mutable linked chart input")
	}
}

type installationNoticeWriter func([]byte) (int, error)

func (write installationNoticeWriter) Write(data []byte) (int, error) {
	return write(data)
}

func TestInstallReceiptOutputBeforeDispatch(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("requires /bin/sh for local command stubs")
	}
	for _, output := range []string{"unwritable", "writable"} {
		t.Run(output, func(t *testing.T) {
			dir := t.TempDir()
			receipt := filepath.Join(dir, "receipt")
			helmCalls := filepath.Join(dir, "helm-calls")
			dispatch := filepath.Join(receipt, "dispatch.json")
			t.Setenv("PATH", dir)
			t.Setenv("HELM_DRIVER", "secret")
			t.Setenv("TEST_INSTALL_HELM_CALLS", helmCalls)
			t.Setenv("TEST_INSTALL_DISPATCH", dispatch)

			write := func(name, data string, mode os.FileMode) string {
				t.Helper()
				path := filepath.Join(dir, name)
				if err := os.WriteFile(path, []byte(data), mode); err != nil {
					t.Fatal(err)
				}
				return path
			}
			write("kubectl", `#!/bin/sh
case "$3:$4" in
  config:view) printf '%s\n' '{"clusters":[{"cluster":{"server":"https://cluster.invalid"}}]}' ;;
  *) exit 1 ;;
esac
`, 0700)
			// Log even a premature install, then require its dispatch record.
			write("helm", `#!/bin/sh
printf '%s\n' "$1" >> "$TEST_INSTALL_HELM_CALLS" || exit 1
case "$1" in
  template) ;;
  list) printf '%s\n' '[]' ;;
  install) test -f "$TEST_INSTALL_DISPATCH" ;;
  *) exit 1 ;;
esac
`, 0700)
			config := installationDoctorKubeconfig(t, "https://cluster.invalid")
			chart := write("chart.tgz", "local chart fixture", 0600)
			values := write("values.yaml", "{}\n", 0600)

			var stdout strings.Builder
			var notice string
			writer := installationNoticeWriter(func(data []byte) (int, error) {
				if notice == "" {
					notice = string(data)
					if _, _, err := loadInstallationReceipt(receipt, "operations", "demo"); err != nil {
						t.Errorf("receipt notice preceded a valid intent: %v", err)
					}
					if _, err := os.Stat(dispatch); !errors.Is(err, os.ErrNotExist) {
						t.Errorf("receipt notice followed the dispatch record: stat error = %v", err)
					}
				}
				if output == "unwritable" {
					return 0, io.ErrClosedPipe
				}
				return stdout.Write(data)
			})

			cmd := New(writer, io.Discard)
			cmd.SetArgs([]string{"installation", "install", "--bootstrap-credentials", "existing", "--kubeconfig", config, "--context", "read",
				"--release", "demo", "--kube-namespace", "operations", "--receipt", receipt,
				"--chart", chart, "--values", values, "--timeout-seconds", "5"})
			runErr := cmd.Execute()
			wantNotice := "Installation intent persisted in " + receipt + ". An interrupted dispatch remains unknown; do not repeat install.\n"
			if notice != wantNotice {
				t.Errorf("attempted receipt output = %q, want %q", notice, wantNotice)
			}
			calls, err := os.ReadFile(helmCalls)
			if err != nil {
				t.Fatal(err)
			}
			if output == "unwritable" {
				if _, _, err := loadInstallationReceipt(receipt, "operations", "demo"); err != nil {
					t.Errorf("intent was not retained after the write failure: %v", err)
				}
				if !errors.Is(runErr, io.ErrClosedPipe) || !strings.Contains(runErr.Error(), "no installation dispatched") {
					t.Errorf("install error = %v, want the output failure and confirmation of no dispatch", runErr)
				}
				if _, err := os.Stat(dispatch); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("expected no dispatch record after the write failure, stat error = %v", err)
				}
				if string(calls) != "template\nlist\n" {
					t.Errorf("Helm calls after the write failure = %q, want only offline validation and list", calls)
				}
				return
			}
			if runErr != nil || string(calls) != "template\nlist\ninstall\n" ||
				!strings.HasPrefix(stdout.String(), wantNotice+"Helm outcome: succeeded.\n") {
				t.Fatalf("writable output: error = %v, Helm calls = %q, stdout = %q", runErr, calls, stdout.String())
			}
			var record map[string]string
			if err := readInstallationRecord(receipt, "dispatch.json", &record); err != nil || record["outcome"] != "unknown" {
				t.Errorf("dispatch record = %v, error = %v", record, err)
			}
		})
	}
}
