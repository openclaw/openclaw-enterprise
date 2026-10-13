package occdev

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClusterNameStartupBoundaries(t *testing.T) {
	// k3d v5.8.3 CheckName caps names at 32 and requires an alphanumeric
	// ending. Development startup additionally owns the narrower prefix and alphabet.
	for _, test := range []struct {
		name  string
		value string
		valid bool
	}{
		{"32 characters", "occ-dev-" + strings.Repeat("a", 24), true},
		{"33 characters", "occ-dev-" + strings.Repeat("a", 25), false},
		{"trailing hyphen", "occ-dev-example-", false},
		{"generated default shape", "occ-dev-abc234def5", true},
		{"shortest suffix", "occ-dev-a", true},
		{"digit ending", "occ-dev-test-1", true},
		{"digit suffix", "occ-dev-0", true},
		{"hyphen starts suffix", "occ-dev--a", false},
		{"underscore", "occ-dev-a_b", false},
		{"dotted hostname", "occ-dev-a.b", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateClusterName(test.value)
			if test.valid {
				if err != nil {
					t.Fatalf("valid startup name %q rejected: %v", test.value, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("invalid startup name %q accepted", test.value)
			}
			for _, want := range []string{"OCC_DEVELOPMENT_KUBERNETES_CLUSTER", test.value, "32", "end with a lowercase letter or digit"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not explain %q", err, want)
				}
			}
		})
	}
}

func TestReadStatePreservesHistoricalClusterNames(t *testing.T) {
	for _, mode := range []string{"", "k3d"} {
		for _, name := range []string{"occ-dev-" + strings.Repeat("a", 55), "occ-dev-example-"} {
			t.Run(mode+"/"+name, func(t *testing.T) {
				directory := t.TempDir()
				state := developmentState{
					Version: 3, Repository: directory, ComputeDriver: "kubernetes",
					SandboxDriver: "none", DeploymentMode: mode, ContainerEngine: "docker",
					Cluster: name, DockerHost: "unix:///fixture/docker.sock",
					KeyPath: filepath.Join(directory, "initial-admin-service-key.json"), KeyOwned: true,
				}
				if mode == "" {
					state.ComposeProject = "owned-kubernetes"
				} else {
					state.PlatformNamespace = "oce-system"
					state.APIPort = 3000
					state.BrowserPort = 8443
				}
				data, err := json.Marshal(state)
				if err != nil {
					t.Fatal(err)
				}
				// Load real private state files: names accepted by earlier startup
				// must remain readable so status and cleanup can find their resources.
				files := map[string][]byte{".openclaw-development": []byte(stateMarker), "state.json": data}
				if mode == "" {
					files["compose.yaml"] = []byte("services: {}\n")
				}
				for file, contents := range files {
					if err := os.WriteFile(filepath.Join(directory, file), contents, 0600); err != nil {
						t.Fatal(err)
					}
				}
				loaded, err := readState(directory)
				if err != nil {
					t.Fatalf("historical state rejected: %v", err)
				}
				if loaded.Cluster != name || loaded.DeploymentMode != mode || loaded.directory != directory {
					t.Fatalf("historical state identity changed: %+v", loaded)
				}
			})
		}
	}
}
