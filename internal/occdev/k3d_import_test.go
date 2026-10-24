package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// nodeImportCase is a fakeProfileCommands case for the ctr import on the owned
// node. It succeeds only when the engine's save output reached its stdin.
func nodeImportCase(cluster, result string) string {
	return `"exec -i k3d-` + cluster + `-server-0 ctr -n k8s.io images import --all-platforms -")
  IFS= read -r data || :
  [ "$data" = archive ] || { echo "ctr received $data" >&2; exit 9; }
  ` + result + ` ;;`
}

func TestImageImportStreamsTheSaveIntoTheNode(t *testing.T) {
	image := "openclaw-development/import-0123:occ-dev-1"
	for name, tc := range map[string]struct{ save, load, want, absent string }{
		"success": {save: "printf archive", load: "echo unpacking done"},
		// ctr still receives the whole stream before the save reports its failure.
		"save failure":   {save: "printf archive; echo save refused >&2; exit 42", load: ":", want: "docker image save failed: exit status 42", absent: "node image import failed"},
		"import failure": {save: "printf archive", load: "exit 43", want: "node image import failed: exit status 43", absent: "image save failed"},
		"both fail":      {save: "printf archive; exit 42", load: "exit 43", want: "docker image save failed: exit status 42\nnode image import failed: exit status 43"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("PATH", t.TempDir())
			commands := fakeProfileCommands(t, map[string]string{
				"docker": `"image save --platform linux/amd64 ` + image + `") ` + tc.save + ` ;;
` + nodeImportCase("occ-dev-1", tc.load),
			})
			var stdout, stderr bytes.Buffer
			r := newRunner(Options{Out: &stdout, Err: &stderr})
			r.engine = "docker"

			err := r.importImageIntoNode(context.Background(), "occ-dev-1", image, "linux/amd64")
			if tc.want == "" {
				if err != nil {
					t.Fatalf("%v\n%s\n%s", err, stderr.String(), strings.Join(commands(), "\n"))
				}
				if !strings.Contains(stdout.String(), "unpacking done") {
					t.Fatalf("ctr output was hidden: %q", stdout.String())
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) || (tc.absent != "" && strings.Contains(err.Error(), tc.absent)) {
				t.Fatalf("want %q without %q, got %v", tc.want, tc.absent, err)
			}
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				t.Fatalf("the exit status was lost: %v", err)
			}
			if name == "save failure" && !strings.Contains(stderr.String(), "save refused") {
				t.Fatalf("the engine's diagnostic was hidden: %q", stderr.String())
			}
		})
	}
}

func TestImageImportStopsBothCommandsWhenCanceled(t *testing.T) {
	directory := t.TempDir()
	pidFile := filepath.Join(directory, "ctr.pid")
	image := "openclaw-development/import-0123:occ-dev-1"
	// PATH holds only fixtures, so ctr waits with a shell builtin loop.
	t.Setenv("PATH", t.TempDir())
	fakeProfileCommands(t, map[string]string{
		"docker": `"image save --platform linux/amd64 ` + image + `") printf archive ;;
"exec -i k3d-occ-dev-1-server-0 ctr -n k8s.io images import --all-platforms -") echo $$ > ` + shellQuote(pidFile) + `; while :; do :; done ;;`,
	})
	r := newRunner(Options{})
	r.engine = "docker"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			if data, err := os.ReadFile(pidFile); err == nil && len(data) > 0 {
				cancel()
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()

	if err := r.importImageIntoNode(ctx, "occ-dev-1", image, "linux/amd64"); err == nil || !strings.Contains(err.Error(), "node image import failed") {
		t.Fatalf("a canceled import was not reported: %v", err)
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("the canceled import left process %d behind: %v", pid, err)
	}
}

func TestDevelopmentImageImportStreamsAndVerifiesTheDigest(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	image := "ghcr.io/openclaw/runtime@" + profileTestDigest
	// The staging name mirrors importDevelopmentImage on purpose, so the tag
	// that reaches the cluster is pinned.
	sum := sha256.Sum256([]byte(image))
	staging := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], state.Cluster)
	recorded := "localhost/" + staging
	reference := strings.TrimSuffix(recorded, ":"+state.Cluster) + "@" + profileTestDigest
	server := "k3d-" + state.Cluster + "-server-0"
	// Podman saves without a platform flag and records a `localhost` name.
	commands := fakeProfileCommands(t, map[string]string{
		"podman": `"image inspect ` + staging + `") exit 1 ;;
"tag ` + image + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + recorded + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + recorded + `") echo linux/amd64 ;;
"image save ` + recorded + `") printf archive ;;
` + nodeImportCase(state.Cluster, ":") + `
"exec ` + server + ` ctr -n k8s.io images list") echo "` + recorded + ` application/vnd.oci.image.manifest.v1+json ` + profileTestDigest + `" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + recorded + ` ` + reference + `") ;;
"image rm ` + recorded + `") ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "podman"

	got, err := r.importDevelopmentImage(context.Background(), state, image)
	if err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
	}
	if got != reference {
		t.Fatalf("unexpected runtime reference: %q", got)
	}
	// The digest is read from containerd only after the import finished.
	calls := commands()
	load, list := -1, -1
	for index, call := range calls {
		switch {
		case strings.HasPrefix(call, "podman exec -i "):
			load = index
		case strings.HasSuffix(call, " ctr -n k8s.io images list"):
			list = index
		}
	}
	if load < 0 || list < load {
		t.Fatalf("expected the import before the image lookup:\n%s", strings.Join(calls, "\n"))
	}
	entries, err := os.ReadDir(state.directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the import wrote to the state directory: %v", entries)
	}
}
