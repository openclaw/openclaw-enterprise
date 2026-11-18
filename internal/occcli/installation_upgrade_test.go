package occcli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func executeUpgrade(args ...string) (string, string, error) {
	var out, diagnostic bytes.Buffer
	cmd := New(&out, &diagnostic)
	cmd.SetArgs(append([]string{"installation", "upgrade"}, args...))
	err := cmd.Execute()
	return out.String(), diagnostic.String(), err
}

func TestInstallationUpgradeCLIIntegratesProfileAndCanonicalOwner(t *testing.T) {
	repository, err := checkoutRepository("occ installation upgrade", filepath.Join("scripts", "upgrade-production"))
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(repository)
	directory := t.TempDir()
	profile := filepath.Join(directory, "profile.json")
	checkout, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	revision := strings.TrimSpace(string(checkout))
	images := map[string]string{"controller": "registry.example/controller@sha256:" + strings.Repeat("a", 64)}
	input := map[string]any{
		"kubeconfig": "kubeconfig", "context": "reviewed-context", "namespace": "openclaw-system",
		"release": "oce", "installationDirectory": "rendered", "sourceRevision": revision, "images": images,
	}
	writeProfile := func() {
		t.Helper()
		document, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(profile, document, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeProfile()
	plan, diagnostic, err := executeUpgrade("plan", "--profile", profile)
	if err != nil || diagnostic != "" || !strings.Contains(plan, "reviewed-context") || !strings.Contains(plan, "No cluster contact or writes occurred") {
		t.Fatalf("plan = %q, diagnostic = %q, error = %v", plan, diagnostic, err)
	}
	for _, invalid := range []struct {
		name, source string
		images       map[string]string
	}{
		{"no image", revision, map[string]string{}},
		{"malformed source", "malformed", images},
		{"wrong checkout", strings.Repeat("0", 40), images},
	} {
		input["sourceRevision"], input["images"] = invalid.source, invalid.images
		writeProfile()
		plan, _, err = executeUpgrade("plan", "--profile", profile)
		var invalidStatus *ExitStatusError
		if !errors.As(err, &invalidStatus) || invalidStatus.Code != 2 || plan != "" {
			t.Fatalf("%s plan = %q, error = %v", invalid.name, plan, err)
		}
	}
	input["sourceRevision"], input["images"] = strings.Repeat("0", 40), images
	writeProfile()

	// Planning is offline; an actual upgrade reaches the canonical source guard before cluster access.
	_, diagnostic, err = executeUpgrade("--profile", profile, "--evidence-dir", filepath.Join(directory, "new-evidence"))
	var status *ExitStatusError
	if !errors.As(err, &status) || status.Code != 1 || !strings.Contains(diagnostic, "checkout commit does not match") {
		t.Fatalf("canonical diagnostic = %q, error = %v", diagnostic, err)
	}
	_, diagnostic, err = executeUpgrade("migration", "check", "--profile", profile, "--evidence-dir", filepath.Join(directory, "new-evidence"))
	if !errors.As(err, &status) || status.Code != 1 || !strings.Contains(diagnostic, "checkout commit does not match") {
		t.Fatalf("migration check diagnostic = %q, error = %v", diagnostic, err)
	}
	_, diagnostic, err = executeUpgrade("migration", "apply", "--profile", profile, "--evidence-dir", filepath.Join(directory, "original-evidence"))
	if !errors.As(err, &status) || status.Code != 1 || !strings.Contains(diagnostic, "checkout commit does not match") {
		t.Fatalf("migration apply diagnostic = %q, error = %v", diagnostic, err)
	}
	_, diagnostic, err = executeUpgrade("--profile", profile, "--evidence-dir", filepath.Join(directory, "new-evidence"), "--", "--candidate-values", "private-candidate", "--preflight-only")
	if !errors.As(err, &status) || status.Code != 2 || !strings.Contains(diagnostic, "retain every other original expert option") || strings.Contains(diagnostic, "private-candidate") {
		t.Fatalf("expert option diagnostic = %q, error = %v", diagnostic, err)
	}
	_, _, err = executeUpgrade("--namespace", "wrong", "--profile", profile, "--evidence-dir", filepath.Join(directory, "new-evidence"))
	if err == nil || !strings.Contains(err.Error(), "not used by this production upgrade") {
		t.Fatalf("ignored global flag error = %v", err)
	}
	_, _, err = executeUpgrade("config", "rollback")
	if err == nil || !strings.Contains(err.Error(), "not applied or rolled back") || !strings.Contains(err.Error(), "database and authentication state compatibility") {
		t.Fatalf("configuration rollback error = %v", err)
	}

	evidence := filepath.Join(directory, "evidence")
	if err := os.Mkdir(evidence, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(evidence, "helm-started"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	observed, _, err := executeUpgrade("status", "--evidence-dir", evidence)
	if err != nil || !strings.Contains(observed, "Helm intent was recorded; its outcome remains uncertain") || !strings.Contains(observed, "not current cluster health or resume authority") {
		t.Fatalf("status = %q, error = %v", observed, err)
	}
	t.Chdir(filepath.Join(repository, "internal"))
	_, _, err = executeUpgrade("status", "--evidence-dir", evidence)
	if err == nil || !strings.Contains(err.Error(), "relative paths keep their meaning") {
		t.Fatalf("subdirectory invocation error = %v", err)
	}
	t.Chdir(repository)
	// A link cannot turn unrelated local bytes into a trusted completion observation.
	if err := os.Symlink(filepath.Join(evidence, "helm-started"), filepath.Join(evidence, "completed")); err != nil {
		t.Fatal(err)
	}
	observed, diagnostic, err = executeUpgrade("status", "--evidence-dir", evidence)
	if !errors.As(err, &status) || status.Code != 2 || observed != "" || !strings.Contains(diagnostic, "invalid or nonprivate status marker") {
		t.Fatalf("linked status = %q, diagnostic = %q, error = %v", observed, diagnostic, err)
	}
	other := filepath.Join(directory, "other-evidence")
	if err := os.Mkdir(other, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "completed"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "evidence-link")
	if err := os.Symlink(other, link); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/", "/."} {
		observed, _, err = executeUpgrade("status", "--evidence-dir", link+suffix)
		if !errors.As(err, &status) || status.Code != 2 || observed != "" {
			t.Fatalf("directory link suffix %q: status = %q, error = %v", suffix, observed, err)
		}
	}
}

func TestInstallationUpgradePreservesNativeMigrationHandoffStatus(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "go.mod"), []byte("module github.com/openclaw/openclaw-enterprise\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	// This child isolates the launcher's exit-status contract; the first test invokes the actual owner.
	if err := os.WriteFile(filepath.Join(directory, "scripts", "upgrade-production"), []byte("#!/bin/sh\nprintf '%s\\n' 'migration paused' >&2\nexit 3\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(directory)
	_, diagnostic, err := executeUpgrade("--profile", "profile.json", "--evidence-dir", "evidence")
	var status *ExitStatusError
	if !errors.As(err, &status) || status.Code != 3 || diagnostic != "migration paused\n" {
		t.Fatalf("migration handoff diagnostic = %q, error = %v", diagnostic, err)
	}
}
