package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The stderr k3d v5.8.3 printed when it closed its stream into the node
// before ctr read it (First Agent Smoke, 2026-10-05 and 2026-10-06).
const k3dClosedStreamOutput = `ERRO[0000] Failed to copy read stream. write unix @->/run/docker.sock: use of closed network connection
ERRO[0000] Failed to import image(s) into cluster 'occ-dev-first-agent-smoke': could not load image to cluster from stream /tmp/development-import.tar: error loading image to cluster, first error: failed to copy read stream. io: read/write on closed pipe
WARN[0000] At least one error occured while trying to import the image(s) into the selected cluster(s)`

// fakeK3dImport puts a k3d on PATH that records each call and fails the first
// `failures` imports with `output` on stderr.
func fakeK3dImport(t *testing.T, failures int, output string) string {
	t.Helper()
	directory := t.TempDir()
	calls := filepath.Join(directory, "calls")
	if err := os.WriteFile(filepath.Join(directory, "failure-output"), []byte(output+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := `#!/bin/sh
directory=$(dirname "$0")
echo "$*" >> "$directory/calls"
count=$(wc -l < "$directory/calls")
if [ "$count" -le ` + strconv.Itoa(failures) + ` ]; then
  cat "$directory/failure-output" >&2
  exit 1
fi
exit 0
`
	if err := os.WriteFile(filepath.Join(directory, "k3d"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	return calls
}

func importCalls(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func TestImportArchiveDirectRetriesAClosedStream(t *testing.T) {
	calls := fakeK3dImport(t, 2, k3dClosedStreamOutput)
	var stdout, stderr bytes.Buffer
	r := &runner{opts: Options{Out: &stdout, Err: &stderr}, env: map[string]string{"PATH": os.Getenv("PATH")}}

	if err := r.importArchiveDirect(context.Background(), "/tmp/development-import.tar", "occ-dev-1"); err != nil {
		t.Fatalf("a closed import stream was not retried: %v", err)
	}
	got := importCalls(t, calls)
	if len(got) != 3 {
		t.Fatalf("expected 3 imports, got %d: %q", len(got), got)
	}
	for _, call := range got {
		if call != "image import --mode direct /tmp/development-import.tar -c occ-dev-1" {
			t.Fatalf("unexpected k3d call: %q", call)
		}
	}
	if !strings.Contains(stderr.String(), "read/write on closed pipe") {
		t.Fatalf("k3d output was hidden: %q", stderr.String())
	}
	if !strings.Contains(stdout.String(), "retrying (attempt 3 of 3)") {
		t.Fatalf("the retry notice was hidden: %q", stdout.String())
	}
}

func TestImportArchiveDirectStopsAfterTheAttemptBound(t *testing.T) {
	calls := fakeK3dImport(t, 9, k3dClosedStreamOutput)
	r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}

	err := r.importArchiveDirect(context.Background(), "/tmp/development-import.tar", "occ-dev-1")
	if err == nil || !strings.HasPrefix(err.Error(), "k3d failed: ") {
		t.Fatalf("expected the last k3d failure, got %v", err)
	}
	if got := importCalls(t, calls); len(got) != k3dDirectImportAttempts {
		t.Fatalf("expected %d imports, got %d", k3dDirectImportAttempts, len(got))
	}
}

func TestImportArchiveDirectDoesNotRetryOtherFailures(t *testing.T) {
	for name, output := range map[string]string{
		"missing archive": "ERRO[0000] Failed to import image(s) into cluster 'occ-dev-1': open /tmp/development-import.tar: no such file or directory",
		"ctr refused":     "ERRO[0000] failed to import images in node 'k3d-occ-dev-1-server-0': Exec process in node 'k3d-occ-dev-1-server-0' failed with exit code '1'",
		// ctr failed mid-stream: the node closed the stream, so the copy hit a
		// broken pipe rather than k3d's own closed connection.
		"node closed the stream": `ERRO[0003] Failed to copy read stream. write unix @->/run/docker.sock: write: broken pipe
ERRO[0003] Failed to import image(s) into cluster 'occ-dev-1': could not load image to cluster from stream /tmp/development-import.tar: error loading image to cluster, first error: failed to copy read stream. io: read/write on closed pipe`,
		"closed pipe without copy": `ERRO[0000] something else: write unix @->/run/docker.sock: use of closed network connection
ERRO[0000] something else: io: read/write on closed pipe`,
		"copy without closed pipe": `ERRO[0000] Failed to copy read stream. write unix @->/run/docker.sock: use of closed network connection
ERRO[0000] Failed to import image(s) into cluster 'occ-dev-1': error loading image to cluster, first error: failed to copy read stream. read /tmp/development-import.tar: input/output error`,
	} {
		t.Run(name, func(t *testing.T) {
			calls := fakeK3dImport(t, 9, output)
			r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}

			if err := r.importArchiveDirect(context.Background(), "/tmp/development-import.tar", "occ-dev-1"); err == nil {
				t.Fatal("a failed import was reported as success")
			}
			if got := importCalls(t, calls); len(got) != 1 {
				t.Fatalf("a non-stream failure was retried: %d imports", len(got))
			}
		})
	}
}

func TestImportArchiveDirectDoesNotRetryACanceledContext(t *testing.T) {
	// The import is canceled while k3d runs, after it printed the closed-stream
	// error: the canceled import must fail without announcing a retry.
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "failure-output"), []byte(k3dClosedStreamOutput+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := `#!/bin/sh
directory=$(dirname "$0")
echo "$*" >> "$directory/calls"
cat "$directory/failure-output" >&2
exec sleep 30
`
	if err := os.WriteFile(filepath.Join(directory, "k3d"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			if data, err := os.ReadFile(filepath.Join(directory, "calls")); err == nil && len(data) > 0 {
				time.Sleep(200 * time.Millisecond)
				cancel()
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()
	var stdout bytes.Buffer
	r := &runner{opts: Options{Out: &stdout, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}

	if err := r.importArchiveDirect(ctx, "/tmp/development-import.tar", "occ-dev-1"); err == nil {
		t.Fatal("a canceled import was reported as success")
	}
	if strings.Contains(stdout.String(), "retrying") {
		t.Fatalf("a canceled import announced a retry: %q", stdout.String())
	}
	if got := importCalls(t, filepath.Join(directory, "calls")); len(got) != 1 {
		t.Fatalf("a canceled import was retried: %d imports", len(got))
	}
}

// flakyK3dImportCase is a fakeProfileCommands case for `k3d image import
// --mode direct <archive> -c <cluster>`. Unlike fakeK3dImport, it can fail each
// attempt differently and check the archive the caller saved: every call first
// checks that the archive is still there, the first call then fails with k3d's
// closed-stream error, and later calls fail with laterFailure or, when it is
// empty, succeed.
func flakyK3dImportCase(t *testing.T, cluster, laterFailure string) string {
	t.Helper()
	directory := t.TempDir()
	closed := filepath.Join(directory, "closed-stream")
	laterFailureOutput := filepath.Join(directory, "later-failure")
	if err := os.WriteFile(closed, []byte(k3dClosedStreamOutput+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(laterFailureOutput, []byte(laterFailure), 0o600); err != nil {
		t.Fatal(err)
	}
	marker := shellQuote(filepath.Join(directory, "failed-once"))
	return `"image import --mode direct "*" -c ` + cluster + `")
  [ -s "$5" ] || { echo "archive missing at import: $5" >&2; exit 2; }
  if [ ! -e ` + marker + ` ]; then : > ` + marker + `; cat ` + shellQuote(closed) + ` >&2; exit 1; fi
  if [ -s ` + shellQuote(laterFailureOutput) + ` ]; then cat ` + shellQuote(laterFailureOutput) + ` >&2; exit 1; fi
  echo "INFO[0001] Successfully imported image(s)" ;;`
}

// assertRetriedImport checks that the archive was imported twice, that the
// imported image was looked up only after the import that succeeded, and that
// the archive was removed afterwards.
func assertRetriedImport(t *testing.T, commands []string, archive, cluster, stdout string) {
	t.Helper()
	importCall := "k3d image import --mode direct " + archive + " -c " + cluster
	imports, lastImport, list := 0, -1, -1
	for index, command := range commands {
		switch {
		case command == importCall:
			imports++
			lastImport = index
		case strings.HasSuffix(command, " ctr -n k8s.io images list"):
			list = index
		}
	}
	if imports != 2 || list < lastImport {
		t.Fatalf("expected two imports of %s before the image lookup:\n%s", archive, strings.Join(commands, "\n"))
	}
	if !strings.Contains(stdout, "retrying (attempt 2 of 3)") || !strings.Contains(stdout, "Successfully imported image(s)") {
		t.Fatalf("the retry or k3d's own output was hidden: %q", stdout)
	}
	if _, err := os.Stat(archive); !os.IsNotExist(err) {
		t.Fatalf("the image archive was left behind: %v", err)
	}
}

func TestImportArchiveDirectDoesNotRetryAnotherFailureAfterAClosedStream(t *testing.T) {
	// Each attempt is judged on its own output: a second attempt that fails for
	// another reason must not be retried because the first one lost its stream.
	archive := filepath.Join(t.TempDir(), "development-import.tar")
	if err := os.WriteFile(archive, []byte("archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	commands := fakeProfileCommands(t, map[string]string{
		"k3d": flakyK3dImportCase(t, "occ-dev-1", "ERRO[0000] failed to import images in node 'k3d-occ-dev-1-server-0': Exec process in node 'k3d-occ-dev-1-server-0' failed with exit code '1'\n"),
	})
	var stdout bytes.Buffer
	r := newRunner(Options{Out: &stdout})

	if err := r.importArchiveDirect(context.Background(), archive, "occ-dev-1"); err == nil {
		t.Fatal("a failed import was reported as success")
	}
	if got := commands(); len(got) != 2 {
		t.Fatalf("expected the closed stream retried once and nothing more: %q", got)
	}
	if strings.Count(stdout.String(), "retrying") != 1 {
		t.Fatalf("expected one retry notice: %q", stdout.String())
	}
}

func TestDevelopmentImageImportRetriesAClosedStreamAndVerifiesTheDigest(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	listed := "RECORDED application/vnd.oci.image.manifest.v1+json DIGEST"
	image, recorded, reference, commands := digestImportCommands(t, state, false, "linux/amd64", listed, flakyK3dImportCase(t, state.Cluster, ""))
	var stdout bytes.Buffer
	r := newRunner(Options{Repository: state.Repository, Out: &stdout})
	r.engine = "podman"

	got, err := r.importDevelopmentImage(context.Background(), state, image)
	if err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
	}
	if got != reference {
		t.Fatalf("unexpected runtime reference: %q", got)
	}
	assertRetriedImport(t, commands(), filepath.Join(state.directory, developmentImportArchive(recorded)), state.Cluster, stdout.String())
	// The staging tag exists only for this import; leaving it would block the next run.
	tagged, removed := -1, -1
	for index, command := range commands() {
		if strings.HasPrefix(command, "podman exec ") && strings.Contains(command, " ctr -n k8s.io images tag ") {
			tagged = index
		}
		if command == "podman image rm "+recorded {
			removed = index
		}
	}
	if tagged < 0 || removed < tagged {
		t.Fatalf("the staging tag was not removed after the node tag (tag %d, rm %d):\n%s", tagged, removed, strings.Join(commands(), "\n"))
	}
}

// digestImportCommands fakes podman and k3d for importDevelopmentImage on a
// digest image. stagingExists answers the staging-name probe, platform the
// recorded platform, listed is the node's `ctr images list` output (the
// placeholders RECORDED and DIGEST stand for the recorded name and a valid
// digest), and k3dImport is the k3d case for the archive import. The staging
// name mirrors importDevelopmentImage on purpose, so the tag that reaches the
// cluster is pinned.
func digestImportCommands(t *testing.T, state *developmentState, stagingExists bool, platform, listed, k3dImport string) (image, recorded, reference string, commands func() []string) {
	t.Helper()
	image = "ghcr.io/openclaw/runtime@" + profileTestDigest
	sum := sha256.Sum256([]byte(image))
	staging := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], state.Cluster)
	recorded = "localhost/" + staging
	reference = strings.TrimSuffix(recorded, ":"+state.Cluster) + "@" + profileTestDigest
	server := "k3d-" + state.Cluster + "-server-0"
	probe := "exit 1"
	if stagingExists {
		probe = "echo '[{}]'"
	}
	listed = strings.NewReplacer("RECORDED", recorded, "DIGEST", profileTestDigest).Replace(listed)
	commands = fakeProfileCommands(t, map[string]string{
		"podman": `"image inspect ` + staging + `") ` + probe + ` ;;
"tag ` + image + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + recorded + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + recorded + `") echo ` + platform + ` ;;
"image save --output "*" ` + recorded + `") printf archive > "$4" ;;
"exec ` + server + ` ctr -n k8s.io images list") printf '%s\n' "` + listed + `" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + recorded + ` ` + reference + `") ;;
"image rm ` + recorded + `") ;;`,
		"k3d": k3dImport,
	})
	return image, recorded, reference, commands
}

func TestDevelopmentImageImportRefusesWhatItCannotVerify(t *testing.T) {
	for _, tc := range []struct {
		name          string
		stagingExists bool
		platform      string
		listed        string
		want          string
	}{
		// Tagging over an existing staging name, then removing it, would delete
		// an image this run does not own.
		{"existing staging image", true, "linux/amd64", "RECORDED application/vnd.oci.image.manifest.v1+json DIGEST", "development staging image already exists"},
		{"non-Linux platform", false, "darwin/arm64", "RECORDED application/vnd.oci.image.manifest.v1+json DIGEST", "must contain a Linux platform"},
		{"two digests for one name", false, "linux/amd64", "RECORDED application/vnd.oci.image.manifest.v1+json DIGEST\nRECORDED application/vnd.oci.image.manifest.v1+json sha256:" + strings.Repeat("0", 64), "ambiguous imported image"},
		{"malformed digest", false, "linux/amd64", "RECORDED application/vnd.oci.image.manifest.v1+json sha256:abc", "could not resolve imported image digest"},
		// Nothing listed under the recorded name leaves the digest empty.
		{"image absent from the node", false, "linux/amd64", "other/image:1 application/vnd.oci.image.manifest.v1+json DIGEST", "could not resolve imported image digest"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			image, recorded, _, commands := digestImportCommands(t, state, tc.stagingExists, tc.platform, tc.listed, `"image import --mode direct "*" -c `+state.Cluster+`") ;;`)
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "podman"
			got, err := r.importDevelopmentImage(context.Background(), state, image)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %q, %v; want %q\n%s", got, err, tc.want, strings.Join(commands(), "\n"))
			}
			removed := false
			for _, command := range commands() {
				if strings.HasPrefix(command, "podman tag ") && tc.stagingExists {
					t.Fatalf("retagged over an existing staging image: %q", command)
				}
				if strings.Contains(command, " ctr -n k8s.io images tag ") {
					t.Fatalf("tagged an unverified image in the node: %q", command)
				}
				removed = removed || command == "podman image rm "+recorded
			}
			if removed == tc.stagingExists {
				t.Fatalf("staging image removal = %v for staging-exists = %v:\n%s", removed, tc.stagingExists, strings.Join(commands(), "\n"))
			}
		})
	}
}

// A digest-pinned development image is a manifest list on Docker's containerd
// image store, so the staging tag must move to the platform child the
// registry's list names before the archive is saved.
func TestDevelopmentImageImportTagsThePlatformChildOfAManifestList(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	image := "ghcr.io/openclaw/runtime@" + profileTestDigest
	child := "sha256:" + strings.Repeat("c", 64)
	resolved := "ghcr.io/openclaw/runtime@" + child
	// The staging name mirrors importDevelopmentImage on purpose, so the tag
	// that reaches the cluster is pinned.
	sum := sha256.Sum256([]byte(image))
	staging := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], state.Cluster)
	recorded := "localhost/" + staging
	reference := strings.TrimSuffix(recorded, ":"+state.Cluster) + "@" + child
	server := "k3d-" + state.Cluster + "-server-0"
	// Podman's `manifest inspect --verbose` prints the bare OCI index.
	listing := `{"schemaVersion":2,"manifests":[{"digest":"` + child + `","platform":{"os":"linux","architecture":"amd64"}},{"digest":"sha256:` + strings.Repeat("d", 64) + `","platform":{"os":"linux","architecture":"arm64"}}]}`
	commands := fakeProfileCommands(t, map[string]string{
		"podman": `"image inspect ` + staging + `") exit 1 ;;
"tag ` + image + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + recorded + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + recorded + `") echo linux/amd64 ;;
"manifest inspect --verbose ` + image + `") printf '%s\n' '` + listing + `' ;;
"image inspect ` + resolved + `") exit 1 ;;
"pull ` + resolved + `") ;;
"tag ` + resolved + ` ` + recorded + `") ;;
"image save --output "*" ` + recorded + `") printf archive > "$4" ;;
"exec ` + server + ` ctr -n k8s.io images list") echo "` + recorded + ` application/vnd.oci.image.manifest.v1+json ` + child + `" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + recorded + ` ` + reference + `") ;;
"image rm ` + recorded + `") ;;`,
		"k3d": `"image import --mode direct "*" -c ` + state.Cluster + `") ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "podman"

	got, err := r.importDevelopmentImage(context.Background(), state, image)
	if err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
	}
	calls := commands()
	if !slices.Contains(calls, "podman tag "+resolved+" "+recorded) {
		t.Fatalf("staging tag never moved to the platform child: %v", calls)
	}
	save := "podman image save --output " + filepath.Join(state.directory, developmentImportArchive(recorded)) + " " + recorded
	if !slices.Contains(calls, save) {
		t.Fatalf("the platform child was not saved without a platform filter: %v", calls)
	}
	if got != reference {
		t.Fatalf("unexpected runtime reference: %q", got)
	}
}
