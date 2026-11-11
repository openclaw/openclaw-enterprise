package occdev

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDockerDownRemovesOnlyRecordedOwnedKeyDirectories(t *testing.T) {
	temporary, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", temporary)
	browser := filepath.Join(temporary, "occ-docker-0123456789abcdef")
	if err := os.Mkdir(browser, 0700); err != nil {
		t.Fatal(err)
	}
	keyDirectory := func(name string, files ...string) string {
		directory := filepath.Join(temporary, name)
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		for _, file := range files {
			if err := os.WriteFile(filepath.Join(directory, file), []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		return directory
	}
	// dev-up's own directories: a copied key, an interrupted copy, and an empty one.
	copied := keyDirectory("openclaw-dev-up-key.copied0001", "initial-admin-service-key.json")
	interrupted := keyDirectory("openclaw-dev-up-key.partial001", ".dev-up-service-key.abcdefghij")
	empty := keyDirectory("openclaw-dev-up-key.empty00001")
	gone := filepath.Join(temporary, "openclaw-dev-up-key.gone000001")
	// Entries down must keep: something dev-up did not write, a directory that is not
	// dev-up's, and a key directory outside the temporary directory.
	foreign := keyDirectory("openclaw-dev-up-key.foreign001", "initial-admin-service-key.json", "notes.txt")
	unrelated := keyDirectory("operator-keys", "initial-admin-service-key.json")
	elsewhere := filepath.Join(t.TempDir(), "openclaw-dev-up-key.elsewhere1")
	if err := os.Mkdir(elsewhere, 0700); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(browser, developmentKeyDirectoryRecord)
	entries := []string{copied, interrupted, empty, gone, foreign, unrelated, elsewhere, "relative/openclaw-dev-up-key.x"}
	if err := os.WriteFile(record, []byte(strings.Join(entries, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}

	var out, warnings bytes.Buffer
	removeRecordedDevelopmentKeyDirectories(browser, &out, &warnings)

	for _, directory := range []string{copied, interrupted, empty} {
		if _, err := os.Lstat(directory); !os.IsNotExist(err) {
			t.Errorf("%s was not removed: %v", directory, err)
		}
		if !strings.Contains(out.String(), "Removed service key directory "+directory+".") {
			t.Errorf("output does not report removing %s:\n%s", directory, out.String())
		}
	}
	if strings.Contains(out.String(), gone) {
		t.Errorf("output reports removing an absent directory:\n%s", out.String())
	}
	for _, directory := range []string{foreign, unrelated, elsewhere} {
		if _, err := os.Stat(directory); err != nil {
			t.Errorf("%s was removed: %v", directory, err)
		}
		if !strings.Contains(warnings.String(), "kept service key directory "+directory) {
			t.Errorf("warnings do not name %s:\n%s", directory, warnings.String())
		}
	}
	if _, err := os.Stat(filepath.Join(foreign, "initial-admin-service-key.json")); err != nil {
		t.Errorf("a key next to foreign content was removed: %v", err)
	}
	// Only the kept entries stay recorded, so a later down retries just those.
	data, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Fields(string(data)), []string{foreign, unrelated, elsewhere, "relative/openclaw-dev-up-key.x"}; strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("record = %q, want %q", got, want)
	}

	// Once nothing needs attention the record goes too.
	if err := os.WriteFile(record, []byte(gone+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	removeRecordedDevelopmentKeyDirectories(browser, &out, &warnings)
	if _, err := os.Lstat(record); !os.IsNotExist(err) {
		t.Fatalf("the record survived an all-clean down: %v", err)
	}
	// No record (a --key-output start or an earlier down) is not an error.
	warnings.Reset()
	removeRecordedDevelopmentKeyDirectories(browser, &out, &warnings)
	if warnings.Len() != 0 {
		t.Fatalf("a missing record produced warnings: %s", warnings.String())
	}
}

func TestDockerDownVolumesRemovesOnlyTheInstallationsNamespaceNetworks(t *testing.T) {
	commands := fakeProfileCommands(t, map[string]string{
		"docker": `
"compose -p dev exec -T postgres psql -U postgres -d openclaw_enterprise -AtX -c SELECT id FROM occ.namespaces") printf 'ns-one\nns-two\n' ;;
"network ls --filter label=org.openclaw.enterprise.managed=true --filter label=org.openclaw.enterprise.compute-driver=docker --filter label=org.openclaw.enterprise.namespace-id=ns-one --format {{.Name}}") echo oce-ns-one-0123456789ab ;;
"network ls --filter label=org.openclaw.enterprise.managed=true --filter label=org.openclaw.enterprise.compute-driver=docker --filter label=org.openclaw.enterprise.namespace-id=ns-two --format {{.Name}}") echo oce-ns-two-0123456789ab ;;
"network rm oce-ns-one-0123456789ab") ;;
"network rm oce-ns-two-0123456789ab") echo 'Error response from daemon: error while removing network: network oce-ns-two-0123456789ab has active endpoints' >&2; exit 1 ;;
`,
	})
	var out, warnings bytes.Buffer
	r := &runner{engine: "docker", env: newRunner(Options{}).env, opts: Options{Out: &out, Err: &warnings}}
	ids, err := r.dockerNamespaceIDs(context.Background(), []string{"compose", "-p", "dev"})
	if err != nil || strings.Join(ids, ",") != "ns-one,ns-two" {
		t.Fatalf("Namespace IDs = %q, %v", ids, err)
	}
	r.removeDockerNamespaceNetworks(context.Background(), ids, nil)
	if !strings.Contains(out.String(), "Removed Docker Compute Namespace network oce-ns-one-0123456789ab.") {
		t.Errorf("output does not report the removed network:\n%s", out.String())
	}
	// A network whose containers still run stays, and down says so.
	if !strings.Contains(warnings.String(), "kept Docker Compute Namespace network oce-ns-two-0123456789ab") {
		t.Errorf("warnings do not name the network in use:\n%s", warnings.String())
	}
	if got := len(commands()); got != 5 {
		t.Errorf("ran %d commands, want 5: %q", got, commands())
	}

	// Without the database's Namespaces nothing is removed: no other stack's network can match.
	out.Reset()
	warnings.Reset()
	r.removeDockerNamespaceNetworks(context.Background(), nil, errors.New("service postgres is not running"))
	if out.Len() != 0 || !strings.Contains(warnings.String(), "may remain") {
		t.Errorf("a failed lookup: output %q, warnings %q", out.String(), warnings.String())
	}
}

func TestDockerNamespaceIDsRefusesUnexpectedValues(t *testing.T) {
	fakeProfileCommands(t, map[string]string{
		"docker": `"compose exec -T postgres psql "*) printf 'ns-one\nns-two,label=other\n' ;;`,
	})
	r := &runner{engine: "docker", env: newRunner(Options{}).env}
	if _, err := r.dockerNamespaceIDs(context.Background(), []string{"compose"}); err == nil || !strings.Contains(err.Error(), "unexpected Namespace ID") {
		t.Fatalf("an unexpected Namespace ID was accepted: %v", err)
	}
}
