package occdev

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeEngine puts a container engine named after the runner's selection on
// PATH. It answers only the inspect commands image resolution issues, so a
// test passes only when resolution asks what the real CLI supports.
func fakeEngine(t *testing.T, engine string, script string) {
	t.Helper()
	directory := t.TempDir()
	body := "#!/bin/sh\ncase \"$*\" in\n" + script +
		"*) echo \"unexpected: " + engine + " $*\" >&2; exit 99 ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(directory, engine), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestEngineImageReferenceQualifiesAPodmanLocalBuild(t *testing.T) {
	// Podman stores an unqualified local build under the `localhost` registry.
	// Both `k3d image import` and containerd match the recorded name exactly,
	// so resolution must report the qualified name rather than the requested
	// one; the requested name finds no image and startup cannot continue.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} openclaw-enterprise-runtime:kubernetes-quickstart") echo '["localhost/openclaw-enterprise-runtime:kubernetes-quickstart"]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "openclaw-enterprise-runtime:kubernetes-quickstart")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "localhost/openclaw-enterprise-runtime:kubernetes-quickstart" {
		t.Fatalf("unexpected recorded reference: %q", reference)
	}
}

func TestEngineImageReferenceSelectsTheRequestedTagAmongSeveral(t *testing.T) {
	// A staging tag shares its image with the build it was tagged from, so the
	// engine reports both names. Resolution must return the requested one;
	// importing the other would stage an unrelated reference into the cluster.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} openclaw-development/import-abc:occ-dev-1") echo '["localhost/openclaw-development/import-abc:occ-dev-1","localhost/openclaw-enterprise-runtime:kubernetes-quickstart"]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "openclaw-development/import-abc:occ-dev-1")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "localhost/openclaw-development/import-abc:occ-dev-1" {
		t.Fatalf("resolution selected an unrelated tag: %q", reference)
	}
}

func TestEngineImageReferencePreservesADockerName(t *testing.T) {
	// Docker keeps an unqualified name as written, so resolution must leave it
	// alone and not invent a registry the engine does not record.
	fakeEngine(t, "docker", `
"image inspect --format {{json .RepoTags}} openclaw-enterprise-runtime:kubernetes-quickstart") echo '["openclaw-enterprise-runtime:kubernetes-quickstart"]' ;;
`)
	r := &runner{engine: "docker", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "openclaw-enterprise-runtime:kubernetes-quickstart")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "openclaw-enterprise-runtime:kubernetes-quickstart" {
		t.Fatalf("a Docker name was rewritten: %q", reference)
	}
}

func TestEngineImageReferencePreservesAFullyQualifiedName(t *testing.T) {
	// An explicitly selected registry image is already qualified, so neither
	// engine rewrites it and resolution must return it unchanged.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} quay.io/openclaw/runtime:v1") echo '["quay.io/openclaw/runtime:v1"]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "quay.io/openclaw/runtime:v1")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "quay.io/openclaw/runtime:v1" {
		t.Fatalf("a qualified name was rewritten: %q", reference)
	}
}

func TestEngineImageReferenceRejectsAnImageWithNoMatchingTag(t *testing.T) {
	// An untagged image cannot be imported by name. Fail here rather than hand
	// k3d a reference the cluster will never resolve.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} openclaw-enterprise-runtime:kubernetes-quickstart") echo '[]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	if _, err := r.engineImageReference(context.Background(), "openclaw-enterprise-runtime:kubernetes-quickstart"); err == nil {
		t.Fatal("resolution accepted an image with no matching tag")
	}
}

func TestEngineImageReferenceMatchesDefaultTagAndRegistry(t *testing.T) {
	cases := []struct {
		name   string
		engine string
		image  string
		tags   string
		want   string
	}{
		{"qualified official to familiar", "docker", "docker.io/library/postgres:17", `["postgres:17"]`, "postgres:17"},
		{"qualified official default tag", "docker", "docker.io/library/postgres", `["postgres:latest"]`, "postgres:latest"},
		{"docker hub shorthand to familiar", "docker", "docker.io/postgres:17", `["postgres:17"]`, "postgres:17"},
		{"legacy docker hub to familiar", "docker", "index.docker.io/library/postgres:17", `["postgres:17"]`, "postgres:17"},
		{"qualified namespace to familiar", "docker", "docker.io/team/postgres:17", `["team/postgres:17"]`, "team/postgres:17"},
		{"qualified official prefers exact tag", "docker", "docker.io/library/postgres:17", `["postgres:17","docker.io/library/postgres:17"]`, "docker.io/library/postgres:17"},
		{"qualified official rejects registry port", "docker", "docker.io/library/postgres:17", `["docker.io:5000/library/postgres:17"]`, ""},
		{"qualified official rejects nested library", "docker", "docker.io/library/postgres:17", `["library/nested/postgres:17"]`, ""},
		{"qualified official rejects other registry", "docker", "docker.io/library/postgres:17", `["other.example/library/postgres:17"]`, ""},
		{"qualified official rejects other namespace", "docker", "docker.io/library/postgres:17", `["team/postgres:17"]`, ""},
		{"qualified namespace rejects official", "docker", "docker.io/team/postgres:17", `["postgres:17"]`, ""},
		{"qualified official rejects different tag", "docker", "docker.io/library/postgres:17", `["postgres:18"]`, ""},
		{"qualified official rejects digest", "docker", "docker.io/library/postgres@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", `["postgres:latest"]`, ""},
		{"docker hub port remains distinct", "docker", "docker.io:5000/library/postgres:17", `["postgres:17"]`, ""},
		{"qualified aliases ambiguous", "docker", "docker.io/library/postgres:17", `["postgres:17","library/postgres:17"]`, ""},
		{"library official to familiar", "docker", "library/postgres:17", `["postgres:17"]`, "postgres:17"},
		{"library official default tag", "docker", "library/postgres", `["postgres:latest"]`, "postgres:latest"},
		{"library official to podman pulled", "podman", "library/postgres:17", `["docker.io/library/postgres:17"]`, "docker.io/library/postgres:17"},
		{"familiar official to library", "docker", "postgres:17", `["library/postgres:17"]`, "library/postgres:17"},
		{"library official rejects different tag", "docker", "library/postgres:17", `["postgres:18"]`, ""},
		{"library official default tag rejects other tag", "docker", "library/postgres", `["postgres:17"]`, ""},
		{"library official rejects other namespace", "docker", "library/postgres:17", `["team/postgres:17"]`, ""},
		{"library official rejects nested library", "docker", "library/postgres:17", `["library/nested/postgres:17"]`, ""},
		{"library official rejects registry port", "docker", "library/postgres:17", `["docker.io:5000/postgres:17"]`, ""},
		{"library official rejects other registry", "podman", "library/postgres:17", `["quay.io/postgres:17"]`, ""},
		{"library aliases ambiguous", "podman", "library/postgres:17", `["docker.io/library/postgres:17","localhost/library/postgres:17"]`, ""},
		{"docker default tag", "docker", "runtime", `["runtime:other","runtime:latest"]`, "runtime:latest"},
		{"podman local default tag", "podman", "team/runtime", `["localhost/team/runtime:other","localhost/team/runtime:latest"]`, "localhost/team/runtime:latest"},
		{"podman pulled default tag", "podman", "runtime", `["docker.io/library/runtime:latest"]`, "docker.io/library/runtime:latest"},
		{"registry port default tag", "docker", "registry.example:5000/team/runtime", `["registry.example:5000/team/runtime:other","registry.example:5000/team/runtime:latest"]`, "registry.example:5000/team/runtime:latest"},
		{"registry port explicit tag", "podman", "registry.example:5000/team/runtime:v1", `["registry.example:5000/team/runtime:latest","registry.example:5000/team/runtime:v1"]`, "registry.example:5000/team/runtime:v1"},
		{"exact preferred", "podman", "team/runtime", `["localhost/team/runtime:latest","team/runtime:latest"]`, "team/runtime:latest"},
		{"different tag rejected", "docker", "runtime", `["runtime:other"]`, ""},
		{"different qualified repository rejected", "podman", "registry.example:5000/team/runtime", `["other.example/registry.example:5000/team/runtime:latest"]`, ""},
		{"qualified explicit repository rejected", "podman", "registry.example:5000/team/runtime:v1", `["other.example/registry.example:5000/team/runtime:v1"]`, ""},
		{"ambiguous registry rejected", "podman", "team/runtime", `["localhost/team/runtime:latest","registry.example/team/runtime:latest"]`, ""},
		{"ambiguous explicit tag rejected", "podman", "team/runtime:v1", `["localhost/team/runtime:v1","registry.example/team/runtime:v1"]`, ""},
		{"digest is not a tag", "docker", "runtime@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", `["runtime:latest"]`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeEngine(t, tc.engine, `"image inspect --format {{json .RepoTags}} `+tc.image+`") echo '`+tc.tags+`' ;;`+"\n")
			r := &runner{engine: tc.engine, env: map[string]string{}}
			got, err := r.engineImageReference(context.Background(), tc.image)
			if tc.want == "" {
				if err == nil {
					t.Fatalf("accepted unrelated or ambiguous tag %q", got)
				}
				if strings.Contains(tc.name, "ambiguous") && !strings.Contains(err.Error(), "ambiguous tags") {
					t.Fatalf("expected an ambiguity error, got %v", err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %q, error %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestImportDevelopmentImagePreservesTaggedImagesAndReleasesPodmanArchives(t *testing.T) {
	// k3d's tools importer cannot use a remote engine's guest socket. Exercise
	// the real launcher step with external CLI contracts and a real archive;
	// the full launcher/engine proof remains a separate integration check.
	for _, tc := range []struct {
		name          string
		engine        string
		saveFailure   bool
		importFailure bool
	}{
		{name: "Podman tagged image", engine: "podman"},
		{name: "Podman partial export fails", engine: "podman", saveFailure: true},
		{name: "Podman direct import fails", engine: "podman", importFailure: true},
		{name: "Docker tagged image", engine: "docker"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &developmentState{Cluster: "occ-dev-owned", directory: t.TempDir()}
			requested := "openclaw-enterprise-runtime:quickstart"
			recorded := requested
			repository := "docker.io/library/openclaw-enterprise-runtime"
			if tc.engine == "podman" {
				recorded = "localhost/" + requested
				repository = "localhost/openclaw-enterprise-runtime"
			}
			archive := filepath.Join(state.directory, "development-import.tar")
			importMarker := filepath.Join(state.directory, "imported")
			exportResult := ""
			if tc.saveFailure {
				exportResult = "exit 43"
			}
			importResult := ""
			if tc.importFailure {
				importResult = "exit 44"
			}
			engineCases := `"image inspect --format {{json .RepoTags}} ` + requested + `") echo '["` + recorded + `"]' ;;
"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images list") echo '` + recorded + ` application/vnd.oci.image.manifest.v1+json ` + profileTestDigest + `' ;;
"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images tag ` + recorded + ` ` + repository + `@` + profileTestDigest + `") ;;`
			importCases := `"image import ` + recorded + ` -c occ-dev-owned") touch ` + shellQuote(importMarker) + ` ;;`
			if tc.engine == "podman" {
				engineCases += `
"image inspect --format {{.Os}}/{{.Architecture}} ` + recorded + `") echo linux/arm64 ;;
"image save --output ` + archive + ` ` + recorded + `") umask 077; printf '%s' 'exported fixture bytes' > "$4"; ` + exportResult + ` ;;`
				importCases = `"image import --mode direct ` + archive + ` -c occ-dev-owned") [ "$(cat "$5")" = 'exported fixture bytes' ] || exit 45; touch ` + shellQuote(importMarker) + `; ` + importResult + ` ;;`
			}
			commands := fakeProfileCommands(t, map[string]string{tc.engine: engineCases, "k3d": importCases})
			r := newRunner(Options{})
			r.engine = tc.engine

			reference, err := r.importDevelopmentImage(context.Background(), state, requested)
			calls := strings.Join(commands(), "\n")
			if tc.saveFailure || tc.importFailure {
				if err == nil || reference != "" {
					t.Fatalf("failed image transfer was accepted: %q, %v", reference, err)
				}
				if strings.Contains(calls, "ctr -n k8s.io images list") {
					t.Fatalf("verified an image after failed transfer:\n%s", calls)
				}
			} else if err != nil || reference != repository+"@"+profileTestDigest {
				t.Fatalf("unexpected immutable reference: %q, %v\n%s", reference, err, calls)
			}
			if tc.engine == "podman" && !strings.Contains(calls, "podman image save --output "+archive+" "+recorded) {
				t.Fatalf("Podman did not export its recorded image:\n%s", calls)
			}
			if _, err := os.Stat(archive); !os.IsNotExist(err) {
				t.Fatalf("temporary archive survived: %v", err)
			}
			_, importErr := os.Stat(importMarker)
			if tc.saveFailure {
				if !os.IsNotExist(importErr) {
					t.Fatalf("import ran after a partial export: %v", importErr)
				}
			} else if importErr != nil {
				t.Fatalf("import did not read the expected source: %v\n%s", importErr, calls)
			}
			if strings.Contains(calls, "image rm ") || strings.Contains(calls, tc.engine+" tag ") {
				t.Fatalf("changed the operator's tagged image:\n%s", calls)
			}
		})
	}
}
