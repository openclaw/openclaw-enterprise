//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// These are command-boundary tests, not engine integration. Legacy recovery
// covers k3d absence and deletion failures on both engines; these cases add
// volume outcomes and the older Compose layout without repeating that matrix.
func TestDownImageVolumeRecovery(t *testing.T) {
	for _, tc := range []struct {
		name, engine, mode, cluster, volume, want string
	}{
		{"present/docker", "docker", "k3d", "success", "present", "k3d image volume k3d-occ-dev-recorded-images remains"},
		{"present/podman-compose", "podman", "", "success", "present", "k3d image volume k3d-occ-dev-recorded-images remains"},
		{"unconfirmed/podman", "podman", "k3d", "success", "unconfirmed", "cannot confirm k3d image volume absence"},
		{"unconfirmed/docker-compose", "docker", "", "success", "unconfirmed", "cannot confirm k3d image volume absence"},
		{"absent/docker-compose", "docker", "", "success", "", ""},
		{"absent/podman-compose", "podman", "", "success", "", ""},
		{"other-volume/docker", "docker", "k3d", "success", "other", ""},
		{"other-volume/podman", "podman", "k3d", "success", "other", ""},
		{"already-absent/docker-compose", "docker", "", "absent", "", ""},
		{"already-absent/podman-compose", "podman", "", "absent", "", ""},
		{"delete-fails/docker-compose", "docker", "", "fail", "", "k3d failed"},
		{"delete-fails/podman-compose", "podman", "", "fail", "", "k3d failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory, log, sentinel := downVolumeFixture(t, tc.engine, tc.mode, tc.cluster, false)
			t.Setenv("DOWN_VOLUME", tc.volume)
			run := func(want string) {
				t.Helper()
				var output bytes.Buffer
				err := Down(context.Background(), Options{Repository: filepath.Dir(directory), Out: &output})
				if want != "" {
					if err == nil || !strings.Contains(err.Error(), "cleanup incomplete; preserving "+directory) || !strings.Contains(err.Error(), want) {
						t.Errorf("want recovery diagnostic %q, got %v", want, err)
					}
					if want == "cannot confirm k3d image volume absence" && err != nil && strings.Contains(err.Error(), " remains") {
						t.Errorf("unconfirmed volume reported present: %v", err)
					}
					if err != nil && (tc.volume == "present" || tc.volume == "unconfirmed") {
						// Check the advice separately from the wrapped OS error and paths.
						detail := strings.TrimPrefix(err.Error(), "cleanup incomplete; preserving "+directory+" for recovery: ")
						_, advice, _ := strings.Cut(detail, "; ")
						if !strings.Contains(advice, tc.engine+" endpoint unix:///recorded-engine.sock") || strings.Contains(advice, "volume rm") {
							t.Errorf("recovery advice lacks recorded endpoint context or includes a removal command: %s", advice)
						}
						if tc.volume == "present" && !strings.Contains(advice, "k3d.cluster=occ-dev-recorded ") {
							t.Errorf("recovery advice lacks exact cluster ownership: %s", advice)
						}
						if tc.volume == "unconfirmed" {
							var exitError *exec.ExitError
							if !errors.As(err, &exitError) || exitError.ExitCode() != 8 {
								t.Errorf("inspection error was not preserved: %v", err)
							}
							if strings.Contains(advice, "remov") {
								t.Errorf("unconfirmed inspection advises removal: %s", advice)
							}
						}
					}
					if output.Len() != 0 {
						t.Errorf("premature output: %q", output.String())
					}
					if _, err := readState(directory); err != nil {
						t.Errorf("lost recovery state: %v", err)
					}
				} else {
					if err != nil {
						t.Fatalf("Down: %v", err)
					}
					if output.String() != "Stopped Kubernetes development stack occ-dev-recorded.\n" {
						t.Errorf("unexpected output: %q", output.String())
					}
					if _, err := os.Stat(directory); !os.IsNotExist(err) {
						t.Errorf("state remains: %v", err)
					}
				}
				if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
					t.Fatalf("unrelated fixture changed: %q, %v", data, err)
				}
			}
			run(tc.want)
			calls, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			if tc.cluster == "fail" && bytes.Contains(calls, []byte("volume ls")) {
				t.Errorf("observed volume after failed cleanup: %s", calls)
			}
			if tc.mode == "" {
				stop := strings.Index(string(calls), " stop controller worker-kubernetes")
				cluster := strings.Index(string(calls), "cluster list -o json")
				down := strings.Index(string(calls), " down --volumes")
				volume := strings.Index(string(calls), "volume ls")
				if stop < 0 || cluster < stop || down < cluster || (volume >= 0 && volume < down) {
					t.Errorf("Compose cleanup order: %s", calls)
				}
			}
			if tc.volume == "present" || tc.volume == "unconfirmed" {
				// The fake cluster delete removes only its own marker. Subsequent lists
				// are absent, but volume presence or uncertainty must still retain state.
				run(tc.want)
				t.Setenv("DOWN_VOLUME", "")
				run("")
				calls, err = os.ReadFile(log)
				if err != nil {
					t.Fatal(err)
				}
				if strings.Count(string(calls), "cluster delete occ-dev-recorded") != 1 {
					t.Errorf("retried cluster deletion: %s", calls)
				}
			}
		})
	}
}

// Reuse the recorded-state, endpoint, cluster and unrelated-marker fixture.
// Only the selected engine gets the additional exact Compose grammar.
func downVolumeFixture(t *testing.T, engine, mode, cluster string, bothProviders bool) (string, string, string) {
	t.Helper()
	directory, log, sentinel := recoveryFixture(t, "oce-system", "none", engine, cluster)
	state, err := readState(directory)
	if err != nil {
		t.Fatal(err)
	}
	state.DeploymentMode = mode
	composeCases := ""
	if mode == "" {
		state.ComposeProject = "recorded"
		if err := os.WriteFile(filepath.Join(directory, "compose.yaml"), []byte("services: {}\n"), 0600); err != nil {
			t.Fatal(err)
		}
		prefix := strings.Join(state.composeCommand(), " ")
		composeCases = shellQuote(prefix+" stop controller worker-kubernetes") + "|" + shellQuote(prefix+" down --volumes") + ") ;;\n"
	}
	if err := rewriteState(state); err != nil {
		t.Fatal(err)
	}
	bin := os.Getenv("PATH") // recoveryFixture supplies an isolated, inert PATH.
	providerCheck := ""
	if engine == "podman" && mode == "" {
		// Down resolves the provider path; the fake engine must never invoke it.
		if err := os.WriteFile(filepath.Join(bin, "podman-compose"), []byte("#!/bin/sh\nexit 96\n"), 0700); err != nil {
			t.Fatal(err)
		}
		if bothProviders {
			// With both providers installed, the Kubernetes-profile down must pin
			// docker-compose to match the provider occ dev up selected.
			if err := os.WriteFile(filepath.Join(bin, "docker-compose"), []byte("#!/bin/sh\nexit 96\n"), 0700); err != nil {
				t.Fatal(err)
			}
			providerCheck = `[ "$PODMAN_COMPOSE_PROVIDER" = ` + shellQuote(filepath.Join(bin, "docker-compose")) + ` ] || exit 97
`
		}
	}
	script := `#!/bin/sh
[ "$DOCKER_HOST" = unix:///recorded-engine.sock ] || exit 91
[ -z "$DOCKER_CONTEXT$DOCKER_TLS_VERIFY$DOCKER_CERT_PATH" ] || exit 92
if [ "$RECOVERY_ENGINE" = podman ]; then
 [ "$CONTAINER_HOST" = "$DOCKER_HOST" ] && [ -z "$CONTAINER_CONNECTION" ] || exit 93
fi
` + providerCheck + `printf '%s\n' "$*" >> "$RECOVERY_LOG"
case "$*" in
 'volume ls --filter label=k3d.cluster=occ-dev-recorded --format {{.Name}}')
  case "$DOWN_VOLUME" in
   present) echo k3d-occ-dev-recorded-images ;;
   unconfirmed) exit 8 ;;
   other) echo k3d-occ-dev-recorded-images-other ;;
   '') ;;
   *) exit 94 ;;
  esac ;;
` + composeCases + ` *) exit 95 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, engine), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return directory, log, sentinel
}

func TestDownKubernetesComposeModePrefersDockerCompose(t *testing.T) {
	// occ dev up starts the Kubernetes-profile Compose stack with docker-compose
	// when both providers exist, because its Compose command passes
	// --project-directory, which standalone podman-compose does not support.
	// Down must resolve the same provider, or up and down disagree about which
	// binary stops the stack. The fixture's engine exits 97 unless down pinned
	// the docker-compose path.
	directory, _, sentinel := downVolumeFixture(t, "podman", "", "absent", true)
	var output bytes.Buffer
	if err := Down(context.Background(), Options{Repository: filepath.Dir(directory), Out: &output}); err != nil {
		t.Fatalf("Down: %v", err)
	}
	if output.String() != "Stopped Kubernetes development stack occ-dev-recorded.\n" {
		t.Errorf("unexpected output: %q", output.String())
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Errorf("state remains: %v", err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
		t.Fatalf("unrelated fixture changed: %q, %v", data, err)
	}
}
