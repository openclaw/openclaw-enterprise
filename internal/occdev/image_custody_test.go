package occdev

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type developmentArchiveTestEntry struct {
	name string
	data []byte
	link string
}

func writeDevelopmentArchiveFixture(t *testing.T, entries []developmentArchiveTestEntry) string {
	t.Helper()
	archive := filepath.Join(t.TempDir(), "image.tar")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0600, Size: int64(len(entry.data))}
		if entry.link != "" {
			header.Typeflag, header.Linkname = tar.TypeSymlink, entry.link
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return archive
}

// The process fixture supplies a real Docker-save layout with an image config
// and a valid uncompressed tar layer. The optional OCI metadata models Docker's
// containerd-backed exporter, whose OCI index otherwise wins at import time.
func developmentArchiveFixtureEntries(t *testing.T, repoTag string, dualFormat bool) []developmentArchiveTestEntry {
	t.Helper()
	var layer bytes.Buffer
	if err := tar.NewWriter(&layer).Close(); err != nil {
		t.Fatal(err)
	}
	layerDigest := fmt.Sprintf("sha256:%x", sha256.Sum256(layer.Bytes()))
	config := []byte(`{"architecture":"amd64","os":"linux","config":{},"rootfs":{"type":"layers","diff_ids":["` + layerDigest + `"]}}`)
	configDigest := fmt.Sprintf("sha256:%x", sha256.Sum256(config))
	configPath := "blobs/sha256/" + strings.TrimPrefix(configDigest, "sha256:")
	layerPath := "blobs/sha256/" + strings.TrimPrefix(layerDigest, "sha256:")
	manifest := fmt.Appendf(nil, `[{"Config":%q,"RepoTags":[%q],"Layers":[%q],"LayerSources":{}}]`, configPath, repoTag, layerPath)
	entries := []developmentArchiveTestEntry{{configPath, config, ""}, {layerPath, layer.Bytes(), ""}, {"manifest.json", manifest, ""}}
	if dualFormat {
		ociManifest := fmt.Appendf(nil, `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":%q,"size":%d},"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar","digest":%q,"size":%d}]}`, configDigest, len(config), layerDigest, layer.Len())
		ociDigest := fmt.Sprintf("sha256:%x", sha256.Sum256(ociManifest))
		index := fmt.Appendf(nil, `{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":%q,"size":%d,"annotations":{"io.containerd.image.name":"example.invalid/original:tag","org.opencontainers.image.ref.name":"original"}}]}`, ociDigest, len(ociManifest))
		entries = append(entries,
			developmentArchiveTestEntry{"oci-layout", []byte(`{"imageLayoutVersion":"1.0.0"}`), ""},
			developmentArchiveTestEntry{"index.json", index, ""},
			developmentArchiveTestEntry{"blobs/sha256/" + strings.TrimPrefix(ociDigest, "sha256:"), ociManifest, ""},
			developmentArchiveTestEntry{"repositories", []byte(`{"example.invalid/original":{"tag":"legacy-layer"}}`), ""},
		)
	}
	return entries
}

func developmentImageArchiveFixture(t *testing.T, repoTag string) string {
	t.Helper()
	return writeDevelopmentArchiveFixture(t, developmentArchiveFixtureEntries(t, repoTag, true))
}

func readDevelopmentArchive(t *testing.T, archive string) map[string][]byte {
	t.Helper()
	file, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	files := make(map[string][]byte)
	reader := tar.NewReader(file)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return files
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		files[path.Clean(header.Name)] = data
	}
}

func assertDevelopmentArchive(t *testing.T, source, imported, name string) {
	t.Helper()
	original, actual := readDevelopmentArchive(t, source), readDevelopmentArchive(t, imported)
	for _, removed := range []string{"oci-layout", "index.json", "repositories"} {
		if _, exists := actual[removed]; exists {
			t.Fatalf("competing import metadata %s remains", removed)
		}
	}
	var manifest []struct {
		Config       string
		RepoTags     []string
		Layers       []string
		LayerSources map[string]any
	}
	if err := json.Unmarshal(actual["manifest.json"], &manifest); err != nil || len(manifest) != 1 || !slices.Equal(manifest[0].RepoTags, []string{name}) || manifest[0].LayerSources == nil {
		t.Fatalf("wrong Docker import identity or lost manifest fields: %s (%v)", actual["manifest.json"], err)
	}
	for _, content := range append([]string{manifest[0].Config}, manifest[0].Layers...) {
		if len(original[content]) == 0 || !bytes.Equal(original[content], actual[content]) {
			t.Fatalf("image content %s changed", content)
		}
	}
}

func developmentImportPath(t *testing.T, commands []string, cluster string) string {
	t.Helper()
	prefix, suffix := "k3d image import --mode direct ", " -c "+cluster
	for _, command := range commands {
		if strings.HasPrefix(command, prefix) && strings.HasSuffix(command, suffix) {
			return strings.TrimSuffix(strings.TrimPrefix(command, prefix), suffix)
		}
	}
	t.Fatalf("image archive was not imported: %v", commands)
	return ""
}

func assertNoDevelopmentHostTagMutations(t *testing.T, engine string, commands []string) {
	t.Helper()
	for _, command := range commands {
		if strings.HasPrefix(command, engine+" tag ") || strings.HasPrefix(command, engine+" image tag ") || strings.HasPrefix(command, engine+" image rm ") || strings.HasPrefix(command, engine+" rmi ") {
			t.Fatalf("mutable host-image operation: %s", command)
		}
	}
}

func TestDevelopmentImageImportDoesNotMutateHostTags(t *testing.T) {
	for _, scenario := range []string{"missing", "foreign", "same-image", "inspect-unknown", "replaced-during-export", "export-failed", "import-failed"} {
		t.Run(scenario, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			image := "ghcr.io/openclaw/runtime@" + profileTestDigest
			sum := sha256.Sum256([]byte(image))
			stage := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], state.Cluster)
			recorded := "localhost/" + stage
			reference := strings.TrimSuffix(recorded, ":"+state.Cluster) + "@" + profileTestDigest
			server := "k3d-" + state.Cluster + "-server-0"
			foreignArchive := filepath.Join(state.directory, developmentImportArchive(recorded))
			if err := os.WriteFile(foreignArchive, []byte("preexisting archive"), 0600); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(t.TempDir(), "host-tag")
			held := ""
			if scenario == "foreign" || scenario == "replaced-during-export" {
				held = "foreign"
			}
			if scenario == "same-image" {
				held = "owned-image"
			}
			if held != "" {
				if err := os.WriteFile(marker, []byte(held), 0600); err != nil {
					t.Fatal(err)
				}
			}
			initialProbe := "echo " + shellQuote("Error response from daemon: No such image: "+stage) + " >&2; exit 1"
			if held != "" {
				initialProbe = `echo '[{"Id":"` + profileTestDigest + `"}]'`
			}
			if scenario == "inspect-unknown" {
				initialProbe = "echo 'Cannot connect to image engine' >&2; exit 1"
			}
			source := developmentImageArchiveFixture(t, "example.invalid/original:tag")
			captured := filepath.Join(t.TempDir(), "imported.tar")
			save := "/bin/cp " + shellQuote(source) + ` "$4"`
			if scenario == "replaced-during-export" {
				save += "; printf replacement > " + shellQuote(marker)
			}
			if scenario == "export-failed" {
				save += "; exit 23"
			}
			importArchive := "/bin/cp \"$5\" " + shellQuote(captured)
			if scenario == "import-failed" {
				importArchive += "; exit 24"
			}
			// Retain the old command responses for the red comparison. The host
			// tag marker and command log detect a destructive pre-fix lifecycle.
			commands := fakeProfileCommands(t, map[string]string{
				"podman": `"image inspect ` + stage + `") ` + initialProbe + ` ;;
"tag ` + image + ` ` + stage + `") printf owned-image > ` + shellQuote(marker) + ` ;;
"image inspect --format {{json .RepoTags}} ` + stage + `") echo '["` + recorded + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + image + `"|"image inspect --format {{.Os}}/{{.Architecture}} ` + recorded + `") echo linux/amd64 ;;
"manifest inspect --verbose ` + image + `") echo '{}' ;;
"image save --output "*" ` + image + `"|"image save --output "*" ` + recorded + `") ` + save + ` ;;
"exec ` + server + ` ctr -n k8s.io images list") echo "` + recorded + ` application/vnd.oci.image.manifest.v1+json ` + profileTestDigest + `" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + recorded + ` ` + reference + `") ;;
"image rm "*) /bin/rm -f ` + shellQuote(marker) + ` ;;`,
				"k3d": `"image import --mode direct "*" -c ` + state.Cluster + `") ` + importArchive + ` ;;`,
			})
			r := newRunner(Options{Repository: state.Repository, Out: &bytes.Buffer{}})
			r.engine = "podman"
			got, err := r.importDevelopmentImage(context.Background(), state, image)
			assertNoDevelopmentHostTagMutations(t, "podman", commands())
			if scenario == "export-failed" || scenario == "import-failed" {
				if err == nil || got != "" {
					t.Fatalf("failed operation was reported as successful: %q, %v", got, err)
				}
			} else if err != nil || got != reference {
				t.Fatalf("import = %q, %v; want %q\n%s", got, err, reference, strings.Join(commands(), "\n"))
			}
			want := held
			if scenario == "replaced-during-export" {
				want = "replacement"
			}
			data, readErr := os.ReadFile(marker)
			if want == "" {
				if !os.IsNotExist(readErr) {
					t.Fatalf("created host tag: %q, %v", data, readErr)
				}
			} else if readErr != nil || string(data) != want {
				t.Fatalf("changed foreign host tag: got %q, %v; want %q", data, readErr, want)
			}
			if scenario != "export-failed" {
				assertDevelopmentArchive(t, source, captured, recorded)
				archive := developmentImportPath(t, commands(), state.Cluster)
				if _, err := os.Stat(filepath.Dir(archive)); !os.IsNotExist(err) {
					t.Fatalf("owned archive directory remains: %v", err)
				}
			}
			if data, err := os.ReadFile(foreignArchive); err != nil || string(data) != "preexisting archive" {
				t.Fatalf("changed an unowned archive: %q, %v", data, err)
			}
			if leftovers, err := filepath.Glob(filepath.Join(state.directory, "development-import-*")); err != nil || !slices.Equal(leftovers, []string{foreignArchive}) {
				t.Fatalf("owned export files remain: %v, %v", leftovers, err)
			}
		})
	}
}

func TestDevelopmentImageImportPinsTheLocalImageBeforeExport(t *testing.T) {
	for _, engine := range []string{"docker", "podman"} {
		t.Run(engine, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			image := "openclaw-enterprise-runtime:kubernetes-quickstart"
			recorded, normalized, id := image, "docker.io/library/"+image, profileTestDigest
			savePrefix, outputArgument := "image save --platform linux/amd64 --output ", "$6"
			if engine == "podman" {
				recorded, normalized = "localhost/"+image, "localhost/"+image
				id = strings.TrimPrefix(id, "sha256:")
				savePrefix, outputArgument = "image save --output ", "$4"
			}
			reference := strings.TrimSuffix(normalized, ":kubernetes-quickstart") + "@" + profileTestDigest
			source := developmentImageArchiveFixture(t, recorded)
			captured := filepath.Join(t.TempDir(), "imported.tar")
			marker := filepath.Join(t.TempDir(), "mutable-source")
			if err := os.WriteFile(marker, []byte("selected-image"), 0600); err != nil {
				t.Fatal(err)
			}
			server := "k3d-" + state.Cluster + "-server-0"
			commands := fakeProfileCommands(t, map[string]string{
				engine: `"image inspect --format {{json .RepoTags}} ` + image + `") echo '["` + recorded + `"]' ;;
"image inspect --format {{.Id}} ` + recorded + `") echo ` + id + ` ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + profileTestDigest + `") echo linux/amd64 ;;
"` + savePrefix + `"*" ` + profileTestDigest + `") /bin/cp ` + shellQuote(source) + ` "` + outputArgument + `"; printf replacement > ` + shellQuote(marker) + ` ;;
"exec ` + server + ` ctr -n k8s.io images list") echo "` + normalized + ` application/vnd.docker.distribution.manifest.v2+json ` + profileTestDigest + `" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + normalized + ` ` + reference + `") ;;`,
				"k3d": `"image import --mode direct "*" -c ` + state.Cluster + `") /bin/cp "$5" ` + shellQuote(captured) + ` ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = engine
			got, err := r.importDevelopmentImage(context.Background(), state, image)
			if err != nil || got != reference {
				t.Fatalf("import = %q, %v; want %q; commands: %v", got, err, reference, commands())
			}
			assertNoDevelopmentHostTagMutations(t, engine, commands())
			assertDevelopmentArchive(t, source, captured, recorded)
			if data, err := os.ReadFile(marker); err != nil || string(data) != "replacement" {
				t.Fatalf("the concurrently retagged local image was changed: %q, %v", data, err)
			}
		})
	}
}

func TestDevelopmentImageImportRejectsUnknownLocalIdentity(t *testing.T) {
	for _, inspection := range []string{"echo invalid-image-id", "echo 'engine unavailable' >&2; exit 1"} {
		t.Run(inspection, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			image := "example.invalid/runtime:local"
			commands := fakeProfileCommands(t, map[string]string{
				"docker": `"image inspect --format {{json .RepoTags}} ` + image + `") echo '["` + image + `"]' ;;
"image inspect --format {{.Id}} ` + image + `") ` + inspection + ` ;;`,
				"k3d": `*) echo 'unexpected image import' >&2; exit 92 ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			if got, err := r.importDevelopmentImage(context.Background(), state, image); err == nil || got != "" {
				t.Fatalf("unknown local identity was accepted: %q, %v", got, err)
			}
			if len(commands()) != 2 {
				t.Fatalf("work continued after an unknown local identity: %v", commands())
			}
		})
	}
}

func TestDevelopmentImageImportPreservesDockerArchiveContents(t *testing.T) {
	for _, linkedLayer := range []bool{false, true} {
		t.Run(fmt.Sprintf("linked-layer=%t", linkedLayer), func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			image := "example.invalid/runtime@" + profileTestDigest
			sum := sha256.Sum256([]byte(image))
			selected := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], state.Cluster)
			reference := "docker.io/" + strings.TrimSuffix(selected, ":"+state.Cluster) + "@" + profileTestDigest
			entries := developmentArchiveFixtureEntries(t, "example.invalid/original:tag", false)
			layerPath, layerContent := entries[1].name, entries[1].data
			if linkedLayer {
				entries[1].name = "layers/content.tar"
				entries = append(entries, developmentArchiveTestEntry{layerPath, nil, "../../layers/content.tar"})
			}
			source := writeDevelopmentArchiveFixture(t, entries)
			captured := filepath.Join(t.TempDir(), "imported.tar")
			server := "k3d-" + state.Cluster + "-server-0"
			commands := fakeProfileCommands(t, map[string]string{
				"docker": `"image inspect --format {{.Os}}/{{.Architecture}} ` + image + `") echo linux/amd64 ;;
"buildx imagetools inspect --format {{json .}} ` + image + `") echo '{}' ;;
"image save --platform linux/amd64 --output "*" ` + image + `") /bin/cp ` + shellQuote(source) + ` "$6" ;;
"exec ` + server + ` ctr -n k8s.io images list") echo "` + selected + ` application/vnd.docker.distribution.manifest.v2+json ` + profileTestDigest + `" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + selected + ` ` + reference + `") ;;`,
				"k3d": `"image import --mode direct "*" -c ` + state.Cluster + `") /bin/cp "$5" ` + shellQuote(captured) + ` ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			got, err := r.importDevelopmentImage(context.Background(), state, image)
			if err != nil || got != reference {
				t.Fatalf("import = %q, %v; want %q; commands: %v", got, err, reference, commands())
			}
			if !linkedLayer {
				assertDevelopmentArchive(t, source, captured, selected)
				return
			}
			if actual := readDevelopmentArchive(t, captured); !bytes.Equal(actual["layers/content.tar"], layerContent) {
				t.Fatal("the linked layer content changed")
			}
			file, err := os.Open(captured)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			reader := tar.NewReader(file)
			for {
				header, err := reader.Next()
				if err != nil {
					t.Fatalf("the layer link was not preserved: %v", err)
				}
				if header.Name == layerPath {
					if header.Typeflag != tar.TypeSymlink || header.Linkname != "../../layers/content.tar" {
						t.Fatalf("wrong layer link: %#v", header)
					}
					break
				}
			}
		})
	}
}

func TestDevelopmentImageImportRejectsInvalidArchives(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func([]developmentArchiveTestEntry) []developmentArchiveTestEntry
		want   string
	}{
		{"no Docker manifest", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			return entries[:2]
		}, "no Docker manifest"},
		{"malformed manifest", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			entries[2].data = []byte("{")
			return entries
		}, "exactly one Docker manifest"},
		{"multiple images", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			one := entries[2].data[1 : len(entries[2].data)-1]
			entries[2].data = fmt.Appendf(nil, "[%s,%s]", one, one)
			return entries
		}, "exactly one Docker manifest"},
		{"duplicate manifest", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			return append(entries, developmentArchiveTestEntry{"./manifest.json", entries[2].data, ""})
		}, "duplicate image archive entry"},
		{"duplicate content", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			return append(entries, developmentArchiveTestEntry{"./" + entries[0].name, entries[0].data, ""})
		}, "duplicate image archive entry"},
		{"missing config", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			return entries[1:]
		}, "is missing or invalid"},
		{"missing layer", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			return append(entries[:1], entries[2:]...)
		}, "is missing or invalid"},
		{"escaping path", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			return append(entries, developmentArchiveTestEntry{"../foreign", []byte("foreign"), ""})
		}, "invalid image archive path"},
		{"OCI only", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			return slices.DeleteFunc(entries, func(entry developmentArchiveTestEntry) bool { return entry.name == "manifest.json" })
		}, "no Docker manifest"},
		{"oversized manifest", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			entries[2].data = bytes.Repeat([]byte(" "), (20<<20)+1)
			return entries
		}, "invalid Docker image archive manifest"},
		{"layer references discarded metadata", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			entries[2].data = fmt.Appendf(nil, `[{"Config":%q,"Layers":["index.json"]}]`, entries[0].name)
			return entries
		}, "is missing or invalid"},
		{"layer links to discarded metadata", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			entries[1].data, entries[1].link = nil, "../../index.json"
			return entries
		}, "is missing or invalid"},
		{"discarded metadata links to content", func(entries []developmentArchiveTestEntry) []developmentArchiveTestEntry {
			entries[2].data = fmt.Appendf(nil, `[{"Config":%q,"Layers":["index.json"]}]`, entries[0].name)
			for index := range entries {
				if entries[index].name == "index.json" {
					entries[index].data, entries[index].link = nil, entries[1].name
				}
			}
			return entries
		}, "is missing or invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			image := "example.invalid/runtime@" + profileTestDigest
			source := writeDevelopmentArchiveFixture(t, test.change(developmentArchiveFixtureEntries(t, "example.invalid/original:tag", true)))
			commands := fakeProfileCommands(t, map[string]string{
				"podman": `"image inspect --format {{.Os}}/{{.Architecture}} ` + image + `") echo linux/amd64 ;;
"manifest inspect --verbose ` + image + `") echo '{}' ;;
"image save --output "*" ` + image + `") /bin/cp ` + shellQuote(source) + ` "$4" ;;`,
				"k3d": `*) echo 'unexpected image import' >&2; exit 92 ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "podman"
			got, err := r.importDevelopmentImage(context.Background(), state, image)
			if err == nil || got != "" || !strings.Contains(err.Error(), "prepare development image archive: ") || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("import = %q, %v; want %q; commands: %v", got, err, test.want, commands())
			}
			for _, command := range commands() {
				if strings.HasPrefix(command, "k3d ") || strings.Contains(command, " ctr ") {
					t.Fatalf("invalid archive reached the node: %s", command)
				}
			}
			if leftovers, err := filepath.Glob(filepath.Join(state.directory, "development-import-*")); err != nil || len(leftovers) != 0 {
				t.Fatalf("invalid archive was retained: %v, %v", leftovers, err)
			}
		})
	}
}
