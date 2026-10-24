package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// developmentCodexProfileNames asks the preparation script's own module for the
// localhost profile name it builds for every reviewed Codex version.
//
// The names are produced by the real Node code rather than restated here. A
// test that rebuilt the name from a version constant would agree with itself
// while the two sides drifted apart, which is exactly the failure this guards.
func developmentCodexProfileNames(t *testing.T) []string {
	t.Helper()
	// A minimal RuntimeDefault baseline: the derivation validates its shape and
	// appends the reviewed bwrap rules, so the resulting digest is stable
	// without needing a cluster to report a real node profile.
	const script = `
const { deriveCodexBwrapProfile, reviewedCodexVersions } = await import("../../scripts/lib/codex-seccomp-profile.mjs");
const { developmentCodexProfileName } = await import("../../scripts/lib/codex-seccomp-k3d.mjs");
const baseline = {
  architectures: ["SCMP_ARCH_X86_64"],
  defaultAction: "SCMP_ACT_ERRNO",
  syscalls: [
    { names: ["read"], action: "SCMP_ACT_ALLOW" },
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  ],
};
process.stdout.write(JSON.stringify(reviewedCodexVersions.map((version) =>
  developmentCodexProfileName(deriveCodexBwrapProfile(baseline, { codexVersion: version }), version),
)));
`
	command := exec.Command("node", "--input-type=module", "-e", script)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("could not build Codex profile names with the preparation module: %v", err)
	}
	var names []string
	if err := json.Unmarshal(output, &names); err != nil {
		t.Fatalf("invalid profile name list: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("the preparation module reported no reviewed Codex versions")
	}
	return names
}

func TestDevelopmentCodexSeccompAcceptsEveryReviewedProfileName(t *testing.T) {
	for _, name := range developmentCodexProfileNames(t) {
		if !validDevelopmentCodexSeccompResult("Localhost", name) {
			t.Errorf("the lifecycle rejected the profile name the preparation script installs: %s", name)
		}
	}
}

func TestDevelopmentCodexSeccompAcceptsAnUnconfinedRuntimeDefaultNode(t *testing.T) {
	// A node whose RuntimeDefault profile already denies the Codex sandbox needs
	// no localhost profile, and the script reports that with an empty name.
	if !validDevelopmentCodexSeccompResult("RuntimeDefault", "") {
		t.Error("RuntimeDefault with no installed profile must be accepted")
	}
}

func TestDevelopmentCodexSeccompRejectsUnusableResults(t *testing.T) {
	// Each case is a result the lifecycle must refuse to act on, because acting
	// on it would run the Codex sandbox under a profile nobody verified.
	for _, testCase := range []struct {
		name        string
		mode        string
		profileName string
	}{
		{"an unknown mode", "Unconfined", ""},
		{"an empty mode", "", ""},
		{"RuntimeDefault naming a profile it did not install", "RuntimeDefault", "openclaw/codex-0.158.0-" + hex64 + ".json"},
		{"Localhost without a profile", "Localhost", ""},
		{"a profile outside the openclaw prefix", "Localhost", "other/codex-0.158.0-" + hex64 + ".json"},
		{"an absolute profile path", "Localhost", "/openclaw/codex-0.158.0-" + hex64 + ".json"},
		{"a traversing profile path", "Localhost", "openclaw/../codex-0.158.0-" + hex64 + ".json"},
		{"a profile with no content digest", "Localhost", "openclaw/codex-0.158.0.json"},
		{"a profile with a truncated digest", "Localhost", "openclaw/codex-0.158.0-abc123.json"},
		{"a profile with no version", "Localhost", "openclaw/codex-" + hex64 + ".json"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if validDevelopmentCodexSeccompResult(testCase.mode, testCase.profileName) {
				t.Errorf("accepted an unusable result: mode %q profile %q", testCase.mode, testCase.profileName)
			}
		})
	}
}

const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// The lifecycle is real; all external commands are inert fixtures. HTTP is
// refused separately because routing downloads do not use the command runner.
type k3dOrderingTransport struct{ requests int }

func (transport *k3dOrderingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	transport.requests++
	return nil, errors.New("fixture routing download refused")
}

func TestK3dCodexPreflightOrdering(t *testing.T) {
	for _, scenario := range []string{"refused", "invalid result", "cleanup failure", "cancelled", "accepted", "API failure", "OpenShell routing", "controller import failure", "network check failure"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			state := filepath.Join(root, "state")
			runtimeImage := "example.invalid/runtime@" + profileTestDigest
			controllerImage := "example.invalid/controller@" + profileTestDigest
			digest := sha256.Sum256([]byte(runtimeImage))
			staging := fmt.Sprintf("openclaw-development/import-%x:occ-dev-order", digest[:6])
			imported := "docker.io/" + strings.Split(staging, ":")[0] + "@" + profileTestDigest
			// The controller and PostgreSQL images import alongside the Codex check
			// and the routing install, so each image has its own import fixture.
			imageCases, imageList := "", ""
			for _, image := range []string{runtimeImage, controllerImage, developmentPostgres} {
				sum := sha256.Sum256([]byte(image))
				staging := fmt.Sprintf("openclaw-development/import-%x:occ-dev-order", sum[:6])
				imported := "docker.io/" + strings.Split(staging, ":")[0] + "@" + profileTestDigest
				imageCases += `"image inspect ` + staging + `") exit 1 ;;
"tag ` + image + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + staging + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + staging + `") echo linux/amd64 ;;
"exec k3d-occ-dev-order-server-0 ctr -n k8s.io images tag ` + staging + ` ` + imported + `") ;;
"image rm ` + staging + `") ;;
`
				imageList += staging + " application/vnd.oci.image.manifest.v1+json " + profileTestDigest + "\n"
			}
			probePID := filepath.Join(root, "probe.pid")
			controllerPresent := ":"
			// The network check starts once the controller image is imported and
			// runs alongside the Codex check and the routing install. Its first
			// probe resource waits here until a sibling's outcome cancels it.
			networkProbe := "while :; do :; done"
			// Clear optional lifecycle inputs without reading or recording credentials.
			for _, key := range []string{"DOCKER_CONTEXT", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE", developmentImageRegistrySetting, "OCC_DEVELOPMENT_OPENSHELL_HELM_CHART", "OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART", "OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST"} {
				t.Setenv(key, "")
			}
			for key, value := range map[string]string{
				"OCC_DEVELOPMENT_STATE_DIRECTORY":                   state,
				"OCC_DEVELOPMENT_KUBERNETES_CLUSTER":                "occ-dev-order",
				"OCC_DEVELOPMENT_KUBERNETES_NAMESPACE":              "oce-system",
				"OCC_DEVELOPMENT_CONTAINER_ENGINE":                  "docker",
				"DOCKER_HOST":                                       "unix:///fixture/docker.sock",
				"OCC_DEVELOPMENT_K3D_DNS_RESOLVER":                  "k3d",
				"OCC_DEVELOPMENT_CONTROLLER_IMAGE":                  controllerImage,
				"OCC_KUBERNETES_RUNTIME_IMAGE":                      runtimeImage,
				"OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS":           "41",
				"OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT": "5",
				"OPENCLAW_DEV_PORT":                                 "3000",
				"OCC_DEVELOPMENT_KUBERNETES_API_PORT":               "6443",
				"OCC_DEVELOPMENT_BROWSER_PORT":                      "8443",
			} {
				t.Setenv(key, value)
			}
			transport := &k3dOrderingTransport{}
			previousTransport := http.DefaultTransport
			http.DefaultTransport = transport
			t.Cleanup(func() { http.DefaultTransport = previousTransport })
			// One refused download ends the run; a retry would only wait.
			previousRetry := developmentRoutingManifestRetry
			developmentRoutingManifestRetry.attempts = 1
			t.Cleanup(func() { developmentRoutingManifestRetry = previousRetry })
			probe := "echo 'sandbox fixture refused' >&2; exit 42"
			switch scenario {
			case "accepted":
				probe = `echo '{"mode":"RuntimeDefault","profileName":""}'`
			case "invalid result":
				probe = `echo '{"mode":"Unconfined","profileName":""}'`
			case "cancelled":
				probe = ": > " + shellQuote(filepath.Join(root, "probing")) + "; while :; do :; done"
			case "controller import failure":
				// The controller image is missing, and the import reports it only
				// once the Codex check is running, so its failure must stop the check.
				// PATH holds only fixtures, so both wait with shell builtins.
				probe = "echo $$ > " + shellQuote(probePID) + "; while :; do :; done"
				controllerPresent = "while [ ! -s " + shellQuote(probePID) + " ]; do :; done; exit 1"
			case "network check failure":
				// The first probe resource fails only once the Codex check is
				// running, so the check failure must stop the Codex check.
				probe = "echo $$ > " + shellQuote(probePID) + "; while :; do :; done"
				networkProbe = "while [ ! -s " + shellQuote(probePID) + " ]; do :; done; exit 1"
			}
			deleteResult := ":"
			if scenario == "cleanup failure" {
				deleteResult = "exit 43"
			}
			apiResult := ":"
			if scenario == "API failure" {
				apiResult = "exit 44"
			}
			// PATH contains only our fixtures. Even an unexpected tool cannot
			// fall through to a real infrastructure executable on the host.
			t.Setenv("PATH", t.TempDir())
			commands := fakeProfileCommands(t, map[string]string{
				"git": `"rev-parse --verify HEAD") echo 0123456789abcdef0123456789abcdef01234567 ;;`,
				"docker": `"version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker"}}' ;;
"info") ;;
"image inspect --format {{ index .Config.Labels "*) echo 0123456789abcdef0123456789abcdef01234567 ;;
"exec k3d-occ-dev-order-server-0 nslookup registry-1.docker.io") ;;
"image inspect ` + runtimeImage + `") ;;
"image inspect ` + controllerImage + `") ` + controllerPresent + ` ;;
"image inspect ` + developmentPostgres + `") ;;
` + imageCases + `"image save --platform linux/amd64 --output "*) ;;
"exec k3d-occ-dev-order-server-0 ctr -n k8s.io images list") printf '` + imageList + `' ;;`,
				"k3d": `"cluster list -o json") if [ -f ` + shellQuote(filepath.Join(root, "created")) + ` ]; then echo '[{"name":"occ-dev-order"}]'; else echo '[]'; fi ;;
"cluster create occ-dev-order "*) : > ` + shellQuote(filepath.Join(root, "created")) + ` ;;
"kubeconfig get occ-dev-order") printf '%s\n' 'contexts:' '- name: k3d-occ-dev-order' '  context:' '    cluster: owned' 'clusters:' '- name: owned' '  cluster:' '    server: https://127.0.0.1:6443' ;;
"image import --mode direct "*) [ "$KUBECONFIG" = ` + shellQuote(filepath.Join(state, "kubeconfig")) + ` ] && [ -f "$KUBECONFIG" ] && [ -f ` + shellQuote(filepath.Join(state, "container-kubeconfig")) + ` ] ;;
"cluster delete occ-dev-order") ` + deleteResult + ` ;;`,
				"kubectl": `"--kubeconfig "*" --context k3d-occ-dev-order get --raw=/version") ` + apiResult + ` ;;
"create -f ` + filepath.Join(state, "network-probe-") + `"*"-occ-netcheck-other-"*".json -o json") ` + networkProbe + ` ;;`,
				"helm": `"show chart "*) exit 45 ;;`,
				"node": `"scripts/prepare-development-codex-seccomp.mjs ` + state + ` ` + imported + ` 41") [ -f ` + shellQuote(filepath.Join(state, "state.json")) + ` ] && [ ! -e ` + shellQuote(filepath.Join(state, "installation.yaml")) + ` ] || exit 96
` + probe + ` ;;`,
			})
			driver := "none"
			if scenario == "OpenShell routing" {
				driver = "openshell"
				t.Setenv("OCC_DEVELOPMENT_OPENSHELL_HELM_CHART", root)
				t.Setenv("OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART", root)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if scenario == "cancelled" {
				go func() {
					ticker := time.NewTicker(time.Millisecond)
					defer ticker.Stop()
					for {
						select {
						case <-ctx.Done():
							return
						case <-ticker.C:
							if _, err := os.Stat(filepath.Join(root, "probing")); err == nil {
								cancel()
								return
							}
						}
					}
				}()
			}
			var output, diagnostic bytes.Buffer
			err := upK3d(ctx, Options{Repository: root, Out: &output, Err: &diagnostic}, driver, nil, nil)
			calls := commands()
			wantError := "dedicated Codex sandbox preparation failed"
			switch scenario {
			case "accepted":
				wantError = "fixture routing download refused"
			case "invalid result":
				wantError = "invalid dedicated Codex sandbox preparation result"
			case "API failure":
				wantError = "exit status 44"
			case "OpenShell routing":
				wantError = "fixture routing download refused"
			case "controller import failure":
				wantError = "import the development controller image: explicitly selected controller image must already exist locally"
			case "network check failure":
				wantError = "kubectl create -f " + filepath.Join(state, "network-probe-")
			}
			if err == nil || !strings.Contains(err.Error(), wantError) {
				t.Fatalf("want %q, got %v; commands: %v", wantError, err, calls)
			}
			if scenario == "refused" || scenario == "cleanup failure" {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) || exitErr.ExitCode() != 42 || !strings.Contains(diagnostic.String(), "sandbox fixture refused") {
					t.Fatalf("lost original refusal: %v; %s", err, &diagnostic)
				}
			}
			if scenario == "cancelled" && ctx.Err() != context.Canceled {
				t.Fatalf("expected cancellation, got %v", ctx.Err())
			}
			if scenario == "network check failure" && !strings.Contains(output.String(), "Verifying Kubernetes network isolation before configuring gateway trust...") {
				t.Fatalf("the network check did not start: %s", &output)
			}
			if scenario == "controller import failure" || scenario == "network check failure" {
				// The import or network check failure, not the test deadline,
				// stopped the Codex check, and its process exited before setup returned.
				if ctx.Err() != nil {
					t.Fatalf("the Codex check outlived the failed import: %v", ctx.Err())
				}
				data, err := os.ReadFile(probePID)
				if err != nil {
					t.Fatal(err)
				}
				pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
				if err != nil {
					t.Fatal(err)
				}
				if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
					t.Fatalf("the canceled Codex check left process %d behind: %v", pid, err)
				}
			}
			index := func(prefix string) int {
				result := -1
				for i, call := range calls {
					if strings.HasPrefix(call, prefix) {
						if result >= 0 {
							t.Fatalf("duplicate %q: %v", prefix, calls)
						}
						result = i
					}
				}
				return result
			}
			previous := -1
			stages := []string{"k3d cluster create ", "docker exec k3d-occ-dev-order-server-0 nslookup ", "k3d kubeconfig get ", "kubectl --kubeconfig "}
			runtimeImport := "k3d image import --mode direct " + filepath.Join(state, developmentImportArchive(staging)) + " "
			if driver == "none" && scenario != "API failure" {
				stages = append(stages, "docker tag "+runtimeImage, runtimeImport, "docker exec k3d-occ-dev-order-server-0 ctr -n k8s.io images tag "+staging+" ", "node scripts/prepare-development-codex-seccomp.mjs ")
			} else {
				if index(runtimeImport) >= 0 || index("node ") >= 0 {
					t.Fatal("runtime work preceded its prerequisite")
				}
			}
			stages = append(stages, "k3d cluster delete occ-dev-order")
			for _, stage := range stages {
				i := index(stage)
				if i <= previous {
					t.Fatalf("stage %q out of order or absent: %v", stage, calls)
				}
				previous = i
			}
			wantRequests := 0
			if scenario == "accepted" || scenario == "OpenShell routing" {
				wantRequests = 1
			}
			if transport.requests != wantRequests {
				t.Fatalf("routing downloads: got %d, want %d", transport.requests, wantRequests)
			}
			forbidden := []string{"kubectl apply ", "kubectl create secret ", "helm upgrade "}
			if scenario == "API failure" {
				// The platform images import only once the cluster API answers.
				forbidden = append(forbidden, "docker tag "+controllerImage, "docker tag "+developmentPostgres)
			}
			for _, command := range forbidden {
				if index(command) >= 0 {
					t.Fatalf("unexpected downstream work: %s", command)
				}
			}
			if scenario == "cleanup failure" {
				if !strings.Contains(err.Error(), "rollback incomplete") || !strings.Contains(err.Error(), "exit status 43") {
					t.Fatalf("lost cleanup failure: %v", err)
				}
				if err := privateOwned(state, true); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(filepath.Join(state, "installation.yaml")); !os.IsNotExist(err) {
					t.Fatalf("unexpected Installation: %v", err)
				}
			} else if _, err := os.Stat(state); !os.IsNotExist(err) {
				t.Fatalf("rollback retained state: %v", err)
			}
		})
	}
}
