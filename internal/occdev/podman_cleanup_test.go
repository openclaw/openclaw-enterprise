package occdev

import (
	"context"
	"encoding/json/v2"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPodmanDownConfirmsOwnedResourceRemoval(t *testing.T) {
	for _, scenario := range []string{"shrinking dependencies", "stalled removal", "volume remains"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			directory := filepath.Join(root, "state")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			inventory := filepath.Join(root, "containers")
			volume := filepath.Join(root, "volume")
			state := developmentState{
				Version: 3, Repository: root, ComputeDriver: "kubernetes", SandboxDriver: "none",
				ContainerEngine: "podman", ComposeProject: "occ-dev-cleanup", Cluster: "occ-dev-cleanup",
				DockerHost: "unix:///fixture/podman.sock", KeyPath: filepath.Join(directory, "initial-admin-service-key.json"), KeyOwned: true,
			}
			data, err := json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			for file, data := range map[string][]byte{
				filepath.Join(directory, ".openclaw-development"): []byte(stateMarker),
				filepath.Join(directory, "state.json"):            data,
				filepath.Join(directory, "compose.yaml"):          []byte("services: {}\n"),
				inventory:                                         []byte("prerequisite\ndependent\n"), volume: []byte("owned-volume\n"),
			} {
				if err := os.WriteFile(file, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			remove := `printf 'prerequisite\n' > ` + shellQuote(inventory) + `; exit 1`
			if scenario == "stalled removal" {
				remove = "exit 1"
			}
			removeVolume := "rm " + shellQuote(volume)
			if scenario == "volume remains" {
				removeVolume = "exit 0"
			}
			// These external-command fixtures exercise the real Down lifecycle.
			// The engine refuses prerequisite removal until its dependent is gone,
			// or lies about volume removal; neither condition may lose recovery state.
			commands := fakeProfileCommands(t, map[string]string{
				"k3d": `"cluster list -o json") echo '[]' ;;`,
				"podman": `
"ps --all --quiet --filter label=com.docker.compose.project=occ-dev-cleanup --filter label=com.docker.compose.service=controller"|\
"ps --all --quiet --filter label=com.docker.compose.project=occ-dev-cleanup --filter label=com.docker.compose.service=worker-kubernetes") ;;
"container ls --quiet --all --filter label=com.docker.compose.project=occ-dev-cleanup"|\
"container ls --quiet --all --filter label=io.podman.compose.project=occ-dev-cleanup") cat ` + shellQuote(inventory) + ` ;;
"container rm --force --volumes dependent prerequisite") ` + remove + ` ;;
"container rm --force --volumes prerequisite") : > ` + shellQuote(inventory) + ` ;;
"volume ls --quiet --filter label=com.docker.compose.project=occ-dev-cleanup"|\
"volume ls --quiet --filter label=io.podman.compose.project=occ-dev-cleanup") if [ -f ` + shellQuote(volume) + ` ]; then cat ` + shellQuote(volume) + `; fi ;;
"volume rm owned-volume") ` + removeVolume + ` ;;
"network ls --quiet --filter label=com.docker.compose.project=occ-dev-cleanup"|\
"network ls --quiet --filter label=io.podman.compose.project=occ-dev-cleanup") ;;
`,
			})
			t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "kubernetes")
			t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", directory)
			err = Down(context.Background(), Options{Repository: root})
			_, stateErr := os.Stat(directory)
			if scenario == "shrinking dependencies" {
				if err != nil || !errors.Is(stateErr, os.ErrNotExist) {
					t.Fatalf("successful cleanup retained state: %v / %v", err, stateErr)
				}
			} else if err == nil || stateErr != nil {
				t.Fatalf("incomplete cleanup lost its recovery state: %v / %v", err, stateErr)
			}
			removals := 0
			for _, command := range commands() {
				if strings.Contains(command, "container rm") {
					removals++
				}
				if strings.Contains(command, "--depend") || strings.Contains(command, "prune") || strings.Contains(command, "volume rm --force") || strings.Contains(command, "network rm --force") {
					t.Fatalf("cleanup escaped its owned inventory: %s", command)
				}
			}
			want := 2
			if scenario == "stalled removal" {
				want = 1
			}
			if removals != want {
				t.Fatalf("removal did not stop when the owned set stopped shrinking: %d", removals)
			}
		})
	}
}
