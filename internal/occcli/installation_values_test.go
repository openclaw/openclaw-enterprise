package occcli

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const migrationTestChart = "../../deploy/helm/openclaw-enterprise"

const legacyBootstrapFixture = `  password:
    claimName: fixture-password-pvc
    size: 1Gi
  serviceKey: {claimName: fixture-service-key-pvc}
`

func migrationValuesFixture(t *testing.T) (string, string) {
	t.Helper()
	raw, err := os.ReadFile("../../deploy/examples/production/values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	// Include unrelated settings the chart does not render. Both their YAML
	// spelling and the nested legacy-looking names must survive conversion.
	clean := string(raw) + "\nsiteExtension:\n  password: 'keep'\n  settings: [true, '01', 1, null]\n"
	source := strings.Replace(clean, "bootstrap:\n", "bootstrap:\n"+legacyBootstrapFixture, 1)
	return source, clean
}

func runMigrationValues(t *testing.T, chart, values string, options ...string) (string, string, error) {
	t.Helper()
	args := []string{"installation", "migrate-values", "--chart", chart, "--release", "demo", "--kube-namespace", "operations", "--values", values}
	return runHelp(t, append(args, options...)...)
}

func requireMigrationHelm(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("requires Helm")
	}
	t.Setenv("HELM_DRIVER", "")
	t.Setenv("KUBECONFIG", filepath.Join(t.TempDir(), "absent-kubeconfig"))
}

func TestInstallationMigrateValues(t *testing.T) {
	requireMigrationHelm(t)
	source, clean := migrationValuesFixture(t)
	input := filepath.Join(t.TempDir(), "values.yaml")
	if err := os.WriteFile(input, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(filepath.Dir(input), "converted.yaml")
	stdout, stderr, err := runMigrationValues(t, migrationTestChart, input)
	if err != nil || !strings.Contains(stdout, "Preview passed") || stderr != "" {
		t.Fatalf("preview failed: %v", err)
	}
	if entries, err := os.ReadDir(filepath.Dir(input)); err != nil || len(entries) != 1 {
		t.Fatal("preview changed the input directory")
	}
	// A real conversion publishes exactly the original bytes minus the two
	// legacy entries, so custom values and bootstrap identity remain intact.
	stdout, stderr, err = runMigrationValues(t, migrationTestChart, input, "--out", out)
	if err != nil || !strings.Contains(stdout, "Wrote converted") || stderr != "" {
		t.Fatalf("write failed: %v", err)
	}
	if contents, err := os.ReadFile(out); err != nil || string(contents) != clean {
		t.Fatal("converted file changed bytes outside the retired fields")
	}
	if info, err := os.Lstat(out); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		t.Fatal("converted file must be a regular file with mode 0600")
	}
	if contents, err := os.ReadFile(input); err != nil || string(contents) != source {
		t.Fatal("original values changed")
	}
	if _, _, err := runMigrationValues(t, migrationTestChart, input, "--out", input); err == nil {
		t.Fatal("the original values file was accepted as output")
	}
	if contents, err := os.ReadFile(input); err != nil || string(contents) != source {
		t.Fatal("the output refusal changed the original values")
	}
	// A dangling symlink is also an existing directory entry. Its target is
	// never created as a byproduct of publishing the converted file.
	absent := filepath.Join(filepath.Dir(input), "absent.yaml")
	link := filepath.Join(filepath.Dir(input), "link.yaml")
	if err := os.Symlink(absent, link); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runMigrationValues(t, migrationTestChart, input, "--out", link); err == nil {
		t.Fatal("existing symlink was accepted as output")
	}
	if current, err := os.Readlink(link); err != nil || current != absent {
		t.Fatal("existing symlink changed")
	}
	stdout, _, err = runMigrationValues(t, migrationTestChart, out, "--out", absent)
	if err != nil || !strings.Contains(stdout, "already omit") {
		t.Fatalf("clean input did not return a no-op: %v", err)
	}
	if _, err := os.Lstat(absent); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("conversion created output for clean input or followed the symlink")
	}
}

func TestInstallationMigrateValuesRefusesAmbiguousYAML(t *testing.T) {
	const marker = "fixture-diagnostic-value"
	cases := map[string]string{
		"duplicate keys": "bootstrap:\n  password: " + marker + "\n  'password': null\n",
		"YAML 1.1 keys":  "bootstrap:\n  password: " + marker + "\nyes: 1\non: 2\n",
		"anchors":        "bootstrap:\n  password: &p " + marker + "\n  copy: *p\n",
		"merge key":      "bootstrap:\n  password: " + marker + "\n  <<: {adminEmail: x}\n",
		"explicit tag":   "bootstrap:\n  password: !unsafe " + marker + "\n",
		"documents":      "bootstrap:\n  password: " + marker + "\n---\nother: document\n",
		"flow bootstrap": "bootstrap: {password: " + marker + "}\n",
	}
	for name, source := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			input := filepath.Join(root, "values.yaml")
			out := filepath.Join(root, "converted.yaml")
			if err := os.WriteFile(input, []byte(source), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("HELM_DRIVER", "")
			stdout, stderr, err := runMigrationValues(t, migrationTestChart, input, "--out", out)
			if err == nil || !strings.Contains(err.Error(), "YAML mapping") && !strings.Contains(err.Error(), "simple block entries") {
				t.Fatalf("expected a YAML refusal for %s", name)
			}
			if stdout != "" || stderr != "" || strings.Contains(err.Error(), marker) {
				t.Fatal("refusal exposed input or wrote a success message")
			}
			if _, err := os.Lstat(out); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("refused conversion created output")
			}
		})
	}
}

func TestInstallationMigrateValuesChecksEntireHelmRender(t *testing.T) {
	requireMigrationHelm(t)
	root := t.TempDir()
	chart := filepath.Join(root, "chart")
	if err := os.CopyFS(chart, os.DirFS(migrationTestChart)); err != nil {
		t.Fatal(err)
	}
	source, _ := migrationValuesFixture(t)
	input := filepath.Join(root, "values.yaml")
	out := filepath.Join(root, "converted.yaml")
	if err := os.WriteFile(input, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	// An output under the selected chart would change its future files even
	// when the two frozen renders match. Resolve the output's parent symlink.
	chartAlias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, chartAlias); err != nil {
		t.Fatal(err)
	}
	t.Chdir(chartAlias)
	chartOut := filepath.Join("chart", "converted.yaml")
	if _, _, err := runMigrationValues(t, "chart", input, "--out", chartOut); err == nil || !strings.Contains(err.Error(), "outside the selected chart") {
		t.Fatal("conversion accepted an output inside the chart via a symlink")
	}
	if _, err := os.Lstat(chartOut); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("chart directory changed on refusal")
	}

	// The initialization Job still renders identically. An unrelated Helm hook
	// consuming a retired field must nevertheless block preview and write.
	const hook = `{{- if .Values.installation.attemptId }}
{{- with .Values.bootstrap.password }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: values-conversion-control
  annotations:
    helm.sh/hook: pre-install
data:
  claimName: {{ .claimName | quote }}
{{- end }}
{{- end }}
`
	extension := filepath.Join(chart, "templates", "conversion-control.yaml")
	if err := os.WriteFile(extension, []byte(hook), 0600); err != nil {
		t.Fatal(err)
	}
	for _, options := range [][]string{nil, {"--out", out}} {
		stdout, stderr, err := runMigrationValues(t, chart, input, options...)
		if err == nil || !strings.Contains(err.Error(), "would change the offline Helm render") {
			t.Fatalf("change to an extra Helm hook was accepted: %v", err)
		}
		if stdout != "" || stderr != "" {
			t.Fatal("refusal printed manifests or a success message")
		}
	}
	if _, err := os.Lstat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("changed Helm render created output")
	}

	// Helm's raw error contains a sensitive value from the original inputs.
	const failingTemplate = `{{ fail .Values.bootstrap.password.claimName }}`
	if err := os.WriteFile(extension, []byte(failingTemplate), 0600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := runMigrationValues(t, chart, input, "--out", out)
	if err == nil || !strings.Contains(err.Error(), "cannot resolve bootstrap inputs") {
		t.Fatal("Helm template failure was not reported")
	}
	if stdout != "" || stderr != "" || strings.Contains(err.Error(), "fixture-password-pvc") {
		t.Fatal("Helm template failure exposed values")
	}
	if _, err := os.Lstat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Helm template failure created output")
	}

	// Helm can render unchanged manifests even for a chart that lacks a
	// fresh-only bootstrap Job. Conversion requires the modern install path.
	if err := os.Remove(extension); err != nil {
		t.Fatal(err)
	}
	job := filepath.Join(chart, "templates", "jobs.yaml")
	jobSource, err := os.ReadFile(job)
	if err != nil {
		t.Fatal(err)
	}
	legacyJob := strings.ReplaceAll(string(jobSource), `, "--require-fresh"`, "")
	if err := os.WriteFile(job, []byte(legacyJob), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runMigrationValues(t, chart, input, "--out", out); err == nil || !strings.Contains(err.Error(), "fresh-only bootstrap") {
		t.Fatal("render equality alone accepted a chart without fresh-only bootstrap")
	}
	if _, err := os.Lstat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unsupported chart created output")
	}
}
