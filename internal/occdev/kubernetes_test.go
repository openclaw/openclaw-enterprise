package occdev

import (
	"context"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestImportRuntimePassesTheCheckoutSourceIdentity(t *testing.T) {
	t.Setenv("OCC_KUBERNETES_RUNTIME_IMAGE", "")
	repository := t.TempDir()
	source := map[string]string{
		"commit":              strings.Repeat("a", 40),
		"sourceArchiveSha256": strings.Repeat("b", 64),
		"buildTimestamp":      "2026-01-02T03:04:05Z",
	}
	data, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repository, "deploy/runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "deploy/runtime/openclaw-source.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	// Stop at the external build boundary. This checks argument delivery, not a Docker build.
	fakeEngine(t, "docker", `
build*) printf '%s\n' "$@" > build-args; exit 17 ;;
`)
	r := newRunner(Options{Repository: repository})
	r.engine = "docker"
	if _, err := r.importRuntime(context.Background(), &developmentState{}); err == nil {
		t.Fatal("the failed build was reported as success")
	}
	arguments, err := os.ReadFile(filepath.Join(repository, "build-args"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"build", "-f", "deploy/runtime/Dockerfile",
		"--build-arg", "OPENCLAW_COMMIT=" + source["commit"],
		"--build-arg", "OPENCLAW_SOURCE_SHA256=" + source["sourceArchiveSha256"],
		"--build-arg", "OPENCLAW_BUILD_TIMESTAMP=" + source["buildTimestamp"],
		"--tag", "openclaw-enterprise-runtime:kubernetes-quickstart", "."}
	if got := strings.Split(strings.TrimSpace(string(arguments)), "\n"); !slices.Equal(got, want) {
		t.Fatalf("runtime build arguments = %q, want %q", got, want)
	}
}

func TestImportRuntimeRejectsInvalidSourceIdentityBeforeTheBuild(t *testing.T) {
	t.Setenv("OCC_KUBERNETES_RUNTIME_IMAGE", "")
	valid := `{"commit":"` + strings.Repeat("a", 40) + `","sourceArchiveSha256":"` + strings.Repeat("b", 64) + `","buildTimestamp":"2026-01-02T03:04:05Z"}`
	for name, contents := range map[string]string{
		"missing file":             "",
		"missing fields":           `{}`,
		"invalid JSON":             `{`,
		"invalid commit":           strings.Replace(valid, strings.Repeat("a", 40), "main", 1),
		"invalid archive checksum": strings.Replace(valid, strings.Repeat("b", 64), "unknown", 1),
		"invalid calendar date":    strings.Replace(valid, "2026-01-02", "2026-02-30", 1),
		"non-UTC timestamp":        strings.Replace(valid, "03:04:05Z", "03:04:05+01:00", 1),
		"unknown field":            strings.Replace(valid, `"commit":`, `"extra":true,"commit":`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			repository := t.TempDir()
			if err := os.MkdirAll(filepath.Join(repository, "deploy/runtime"), 0o700); err != nil {
				t.Fatal(err)
			}
			if contents != "" {
				if err := os.WriteFile(filepath.Join(repository, "deploy/runtime/openclaw-source.json"), []byte(contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			// Any engine invocation would record a build attempt despite invalid source metadata.
			fakeEngine(t, "docker", `build*) touch build-attempted; exit 17 ;;`)
			r := newRunner(Options{Repository: repository})
			r.engine = "docker"
			if _, err := r.importRuntime(context.Background(), &developmentState{}); err == nil || !strings.Contains(err.Error(), "openclaw-source.json") {
				t.Fatalf("expected the source identity error, got %v", err)
			}
			if _, err := os.Stat(filepath.Join(repository, "build-attempted")); !os.IsNotExist(err) {
				t.Fatalf("the build ran with invalid source metadata: %v", err)
			}
		})
	}
}

// fakeEngine puts a container engine named after the runner's selection on
// PATH. It answers only each test's selected build or inspect commands, so
// unexpected calls fail instead of silently succeeding.
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

func TestClusterExistsMatchesOnlyTheExactName(t *testing.T) {
	// `occ dev up` and `occ dev down` decide to create, reuse or delete a
	// cluster from this answer, so a neighbouring name must not count.
	for _, tc := range []struct {
		name      string
		inventory string
		want      bool
	}{
		{"neighbouring names", `[{"name":"occ-dev-owned-2"},{"name":"occ-dev-own"}]`, false},
		{"exact name", `[{"name":"occ-dev-owned-2"},{"name":"occ-dev-owned"}]`, true},
		{"no clusters", `[]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeEngine(t, "k3d", `"cluster list -o json") echo '`+tc.inventory+`' ;;`+"\n")
			r := &runner{env: map[string]string{}}
			got, err := r.clusterExists(context.Background(), "occ-dev-owned")
			if err != nil || got != tc.want {
				t.Fatalf("got %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

func TestWriteKubeconfigsPointsContainersAtTheServerLoadBalancer(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	host := filepath.Join(state.directory, "kubeconfig")
	kubeconfig := `apiVersion: v1
kind: Config
clusters:
- name: k3d-occ-dev-owned
  cluster:
    server: https://127.0.0.1:6443
    certificate-authority-data: Y2E=
contexts:
- name: k3d-occ-dev-owned
  context:
    cluster: k3d-occ-dev-owned
    user: admin@k3d-occ-dev-owned
`
	commands := fakeProfileCommands(t, map[string]string{
		"k3d":     `"kubeconfig get occ-dev-owned") cat <<'YAML'` + "\n" + kubeconfig + "YAML\n;;",
		"kubectl": `"--kubeconfig ` + host + ` --context k3d-occ-dev-owned get --raw=/version") echo '{}' ;;`,
	})
	r := &runner{env: map[string]string{}}
	if err := r.writeKubeconfigs(context.Background(), state); err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
	}
	if !slices.Contains(commands(), "kubectl --kubeconfig "+host+" --context k3d-occ-dev-owned get --raw=/version") {
		t.Fatalf("the host kubeconfig was not checked against the API: %q", commands())
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "container-kubeconfig"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"server: https://k3d-occ-dev-owned-serverlb:6443",
		"tls-server-name: k3d-occ-dev-owned-serverlb",
		"certificate-authority-data: Y2E=",
	} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("container kubeconfig lacks %q:\n%s", want, data)
		}
	}
	original, err := os.ReadFile(host)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(original)) != strings.TrimSpace(kubeconfig) {
		t.Fatalf("host kubeconfig changed:\n%s", original)
	}
}

func TestDevelopmentNamespaceWaitRefusesAmbiguousOrUnownedNamespaces(t *testing.T) {
	namespace := func(name, label, annotation string) string {
		return `{"metadata":{"name":"` + name + `","labels":{"openclaw.dev/namespace":"` + label +
			`"},"annotations":{"openclaw.dev/namespace-id":"` + annotation + `"}}}`
	}
	for _, tc := range []struct {
		name  string
		items string
		want  string
	}{
		{"two bootstrap Namespaces", namespace("occ-a", "ns-a", "ns-a") + "," + namespace("occ-b", "ns-b", "ns-b"), "exactly one bootstrap Namespace"},
		{"annotation names another Namespace", namespace("occ-a", "ns-a", "ns-b"), "missing OCC ownership evidence"},
		{"no annotation", `{"metadata":{"name":"occ-a","labels":{"openclaw.dev/namespace":"ns-a"}}}`, "missing OCC ownership evidence"},
		{"owned", namespace("occ-a", "ns-a", "ns-a"), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeEngine(t, "kubectl", `"get namespaces --selector openclaw.dev/namespace -o json") echo '{"items":[`+tc.items+`]}' ;;`+"\n")
			r := &runner{env: map[string]string{}}
			// A fake that does not match the command reads as not ready, so a miss
			// fails here after this short wait instead of with the real cause.
			name, id, err := r.waitForDevelopmentKubernetesNamespace(context.Background(), 2*time.Second)
			if tc.want == "" {
				if err != nil || name != "occ-a" || id != "ns-a" {
					t.Fatalf("got %q, %q, %v", name, id, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %q, %q, %v; want %q", name, id, err, tc.want)
			}
		})
	}
}
