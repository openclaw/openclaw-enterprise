package occcli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
