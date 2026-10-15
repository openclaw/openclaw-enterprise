//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The command fixture represents two clusters on the recorded engine. Down must
// select the recorded cluster despite conflicting settings in the caller's env.
func recoveryFixture(t *testing.T, namespace, sandbox, engine, outcome string) (string, string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "state")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	state := developmentState{
		Version: 3, Repository: root, ComputeDriver: "kubernetes",
		SandboxDriver: sandbox, DeploymentMode: "k3d", PlatformNamespace: namespace,
		APIPort: 3000, BrowserPort: 8443, ContainerEngine: engine,
		Cluster: "occ-dev-recorded", DockerHost: "unix:///recorded-engine.sock",
		KeyPath: filepath.Join(directory, "initial-admin-service-key.json"), KeyOwned: true,
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string][]byte{".openclaw-development": []byte(stateMarker), "state.json": data} {
		if err := os.WriteFile(filepath.Join(directory, name), contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	log := filepath.Join(root, "commands")
	recorded := filepath.Join(root, "recorded-cluster")
	if outcome != "absent" {
		if err := os.WriteFile(recorded, []byte("owned"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	sentinel := filepath.Join(root, "unrelated-cluster")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	const script = `#!/bin/sh
[ "$DOCKER_HOST" = "unix:///recorded-engine.sock" ] || exit 91
[ -z "$DOCKER_CONTEXT$DOCKER_TLS_VERIFY$DOCKER_CERT_PATH" ] || exit 92
if [ "$RECOVERY_ENGINE" = podman ]; then
  [ "$CONTAINER_HOST" = "$DOCKER_HOST" ] && [ -z "$CONTAINER_CONNECTION" ] || exit 93
fi
printf '%s\n' "$*" >> "$RECOVERY_LOG"
case "$*" in
  'cluster list -o json')
    if [ "$RECOVERY_OUTCOME" = absent ]; then
      printf '%s\n' '[{"name":"occ-dev-unrelated"}]'
    else
      printf '%s\n' '[{"name":"occ-dev-recorded"},{"name":"occ-dev-unrelated"}]'
    fi ;;
  'cluster delete occ-dev-recorded')
    [ "$RECOVERY_OUTCOME" != fail ] || exit 7
    /bin/rm -- "$RECOVERY_RESOURCE" ;;
  *) exit 94 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "k3d"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"PATH": bin, "RECOVERY_LOG": log, "RECOVERY_ENGINE": engine, "RECOVERY_OUTCOME": outcome, "RECOVERY_RESOURCE": recorded,
		"OCC_DEVELOPMENT_COMPUTE_DRIVER": "kubernetes", "OCC_DEVELOPMENT_CONTROL_PLANE": "kubernetes",
		"OCC_DEVELOPMENT_SANDBOX_DRIVER": sandbox, "OCC_DEVELOPMENT_STATE_DIRECTORY": directory,
		"OCC_DEVELOPMENT_KUBERNETES_CLUSTER": "occ-dev-unrelated", "DOCKER_HOST": "unix:///wrong.sock",
		"DOCKER_CONTEXT": "wrong-context", "DOCKER_TLS_VERIFY": "1", "DOCKER_CERT_PATH": "/wrong-certs",
		"CONTAINER_HOST": "unix:///wrong-podman.sock", "CONTAINER_CONNECTION": "wrong-connection",
	} {
		t.Setenv(key, value)
	}
	return directory, log, sentinel
}

func TestLegacyNamespaceRecovery(t *testing.T) {
	for _, length := range []int{64, 200} {
		for _, sandbox := range []string{"none", "openshell"} {
			for _, engine := range []string{"docker", "podman"} {
				for _, outcome := range []string{"success", "fail", "absent"} {
					t.Run(fmt.Sprintf("%d/%s/%s/%s", length, sandbox, engine, outcome), func(t *testing.T) {
						directory, log, sentinel := recoveryFixture(t, strings.Repeat("a", length), sandbox, engine, outcome)
						ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer cancel()
						err := Down(ctx, Options{Repository: filepath.Dir(directory)})
						if outcome == "fail" {
							if err == nil || !strings.Contains(err.Error(), "cleanup incomplete; preserving") {
								t.Fatalf("failed deletion did not retain a recovery error: %v", err)
							}
							if _, err := readState(directory); err != nil {
								t.Fatalf("failed deletion lost valid recovery state: %v", err)
							}
						} else {
							if err != nil {
								t.Fatalf("legacy namespace blocked recorded cleanup: %v", err)
							}
							if _, err := os.Lstat(directory); !os.IsNotExist(err) {
								t.Fatalf("successful cleanup retained state: %v", err)
							}
						}
						data, err := os.ReadFile(log)
						want := "cluster list -o json\n"
						if outcome != "absent" {
							want += "cluster delete occ-dev-recorded\n"
						}
						if err != nil || string(data) != want {
							t.Fatalf("cleanup selected unexpected commands: %q, %v", data, err)
						}
						_, resourceErr := os.Stat(filepath.Join(filepath.Dir(directory), "recorded-cluster"))
						if outcome == "fail" {
							if resourceErr != nil {
								t.Fatalf("failed delete lost recorded resource: %v", resourceErr)
							}
						} else if !os.IsNotExist(resourceErr) {
							t.Fatalf("cleanup left recorded resource: %v", resourceErr)
						}
						if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
							t.Fatalf("unrelated resource changed: %q, %v", data, err)
						}
					})
				}
			}
		}
	}
}

func TestLegacyNamespaceRecoveryRejectsInvalidState(t *testing.T) {
	cases := []struct{ field, value string }{
		{"version", "2"}, {"computeDriver", `"docker"`}, {"sandboxDriver", `"invalid"`},
		{"containerEngine", `"invalid"`}, {"deploymentMode", `"invalid"`},
		{"platformNamespace", `"Bad/name"`}, {"cluster", `"unrelated"`},
		{"dockerHost", `"tcp://remote:2375"`}, {"repository", `"relative"`},
		{"keyPath", `"/outside-owned-state.json"`}, {"apiPort", "0"}, {"browserPort", "65536"},
		{"composeProject", `"unexpected"`}, {"unknownMember", "true"},
		{"marker", ""}, {"private-state", ""}, {"private-directory", ""}, {"symlink", ""},
	}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			directory, log, sentinel := recoveryFixture(t, strings.Repeat("a", 200), "none", "docker", "success")
			path := filepath.Join(directory, "state.json")
			switch tc.field {
			case "marker":
				if err := os.WriteFile(filepath.Join(directory, ".openclaw-development"), []byte("invalid\n"), 0600); err != nil {
					t.Fatal(err)
				}
			case "private-state":
				if err := os.Chmod(path, 0644); err != nil {
					t.Fatal(err)
				}
			case "private-directory":
				if err := os.Chmod(directory, 0755); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				alias := filepath.Join(filepath.Dir(directory), "alias")
				if err := os.Symlink(directory, alias); err != nil {
					t.Fatal(err)
				}
				t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", alias)
			default:
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				var state map[string]any
				if err := json.Unmarshal(data, &state); err != nil {
					t.Fatal(err)
				}
				var value any
				if err := json.Unmarshal([]byte(tc.value), &value); err != nil {
					t.Fatal(err)
				}
				state[tc.field] = value
				data, err = json.Marshal(state)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := Down(ctx, Options{Repository: filepath.Dir(directory)}); err == nil {
				t.Fatal("invalid recovery state reached cleanup")
			}
			if _, err := os.Lstat(log); !os.IsNotExist(err) {
				t.Fatalf("invalid state invoked an external command: %v", err)
			}
			if _, err := os.Lstat(path); err != nil {
				t.Fatalf("rejected state was removed: %v", err)
			}
			if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
				t.Fatalf("unrelated resource changed: %q, %v", data, err)
			}
		})
	}
}
