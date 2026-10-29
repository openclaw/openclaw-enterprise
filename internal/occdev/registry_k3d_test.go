package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	registryTestContainer = "oce-first-agent-smoke-registry"
	// The published host port differs from the container port, as on smoke
	// slots other than 0, so a pull from the host port fails the fixtures.
	registryTestPorts   = `{"5000/tcp":[{"HostIp":"127.0.0.1","HostPort":"15001"}]}`
	registryTestRuntime = "127.0.0.1:15001/oce-smoke/runtime@" + profileTestDigest
	registryTestAddress = "172.18.0.5"
)

func registryPortsCase(ports string) string {
	return `"container inspect --format {{json .NetworkSettings.Ports}} ` + registryTestContainer + `") echo '` + ports + `' ;;`
}

func TestDevelopmentImageRegistrySelection(t *testing.T) {
	for name, tc := range map[string]struct {
		ports, runtime, want string
	}{
		"loopback registry serving the runtime": {ports: registryTestPorts, runtime: registryTestRuntime},
		"a port on every address": {
			ports: `{"5000/tcp":[{"HostIp":"0.0.0.0","HostPort":"5000"}]}`, runtime: registryTestRuntime,
			want: "must publish its ports on 127.0.0.1 only",
		},
		"an empty host address (every address)": {
			ports: `{"5000/tcp":[{"HostIp":"","HostPort":"5000"}]}`, runtime: registryTestRuntime,
			want: "must publish its ports on 127.0.0.1 only",
		},
		"loopback and another address": {
			ports:   `{"5000/tcp":[{"HostIp":"127.0.0.1","HostPort":"15001"},{"HostIp":"::","HostPort":"15001"}]}`,
			runtime: registryTestRuntime, want: "must publish its ports on 127.0.0.1 only",
		},
		"stopped container": {ports: `{}`, runtime: registryTestRuntime, want: "publishes no TCP port on 127.0.0.1"},
		"tagged runtime": {
			ports: registryTestPorts, runtime: "127.0.0.1:15001/oce-smoke/runtime:latest",
			want: "no selected controller, runtime, PostgreSQL or repository image is pinned by digest",
		},
		"the container port instead of the published one": {
			ports: registryTestPorts, runtime: "127.0.0.1:5000/oce-smoke/runtime@" + profileTestDigest,
			want: "no selected controller, runtime, PostgreSQL or repository image is pinned by digest",
		},
		"another registry": {
			ports: registryTestPorts, runtime: "ghcr.io/openclaw/runtime@" + profileTestDigest,
			want: "no selected controller, runtime, PostgreSQL or repository image is pinned by digest",
		},
	} {
		t.Run(name, func(t *testing.T) {
			fakeProfileCommands(t, map[string]string{"docker": registryPortsCase(tc.ports)})
			r := newRunner(Options{})
			r.engine = "docker"
			r.env[developmentImageRegistrySetting] = registryTestContainer
			r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] = tc.runtime
			err := r.selectDevelopmentImageRegistry(context.Background())
			if tc.want == "" {
				if err != nil || r.imageRegistry == nil || r.imageRegistry.ports["127.0.0.1:15001"] != "5000" || r.imageRegistry.pending != 1 {
					t.Fatalf("registry not selected: %v %+v", err, r.imageRegistry)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) || r.imageRegistry != nil {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
	t.Run("unset", func(t *testing.T) {
		commands := fakeProfileCommands(t, map[string]string{"docker": ""})
		r := newRunner(Options{})
		r.engine = "docker"
		r.env[developmentImageRegistrySetting] = ""
		r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] = registryTestRuntime
		if err := r.selectDevelopmentImageRegistry(context.Background()); err != nil || r.imageRegistry != nil || len(commands()) != 0 {
			t.Fatalf("an unset registry changed startup: %v %v", err, commands())
		}
	})
}

func TestDevelopmentImageRegistrySource(t *testing.T) {
	registry := &developmentImageRegistry{ports: map[string]string{"127.0.0.1:15001": "5000"}}
	for image, want := range map[string]bool{
		registryTestRuntime: true,
		"127.0.0.1:15001/oce-smoke/runtime:tag@" + profileTestDigest: false,
		"127.0.0.1:15001/oce-smoke/runtime":                          false,
		"127.0.0.1:15001/oce-smoke/runtime@sha256:abc":               false,
		"127.0.0.1:15001@" + profileTestDigest:                       false,
		"localhost:15001/oce-smoke/runtime@" + profileTestDigest:     false,
	} {
		if _, _, got := registry.source(image); got != want {
			t.Errorf("source(%q) = %v, want %v", image, got, want)
		}
	}
	if _, _, ok := (*developmentImageRegistry)(nil).source(registryTestRuntime); ok {
		t.Fatal("no registry served an image")
	}
}

// registryPullCases are the fixture engine's answers for attaching the registry
// and pulling an image through it; listed is the node's image inventory. The
// registry is connected to the cluster network while the marker file exists.
func registryPullCases(cluster, marker, listed string) string {
	server := "k3d-" + cluster + "-server-0"
	return registryPortsCase(registryTestPorts) + `
"network connect k3d-` + cluster + ` ` + registryTestContainer + `") : > ` + shellQuote(marker) + ` ;;
"container inspect --format {{with index .NetworkSettings.Networks \"k3d-` + cluster + `\"}}{{.IPAddress}}{{end}} ` + registryTestContainer + `") if [ -f ` + shellQuote(marker) + ` ]; then echo ` + registryTestAddress + `; fi ;;
"network disconnect k3d-` + cluster + ` ` + registryTestContainer + `") /bin/rm ` + shellQuote(marker) + ` ;;
"image inspect --format {{.Os}}/{{.Architecture}} 127.0.0.1:15001/"*) echo linux/amd64 ;;
"exec ` + server + ` ctr -n k8s.io images pull --plain-http --platform linux/amd64 ` + registryTestAddress + `:5000/oce-smoke/"*) echo "progress that stays hidden" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + registryTestAddress + `:5000/oce-smoke/"*) ;;
"exec ` + server + ` ctr -n k8s.io images list") printf '` + listed + `' ;;`
}

func registryListed(images ...string) string {
	listed := ""
	for _, image := range images {
		listed += image + " application/vnd.oci.image.manifest.v1+json " + profileTestDigest + "\n"
	}
	return listed
}

func countCalls(calls []string, prefix string) int {
	count := 0
	for _, call := range calls {
		if strings.HasPrefix(call, prefix) {
			count++
		}
	}
	return count
}

func TestDevelopmentImageImportPullsRegistryImagesByDigest(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	disconnect := "docker network disconnect k3d-" + state.Cluster + " " + registryTestContainer
	for name, tc := range map[string]struct{ listed, want string }{
		"selected digest": {listed: registryListed(registryTestRuntime)},
		"another digest": {
			listed: registryTestRuntime + " application/vnd.oci.image.manifest.v1+json sha256:" + hex64 + "\n",
			want:   "the pulled image does not match the selected digest",
		},
		"not listed": {listed: "", want: "the pulled image does not match the selected digest"},
	} {
		t.Run(name, func(t *testing.T) {
			commands := fakeProfileCommands(t, map[string]string{"docker": registryPullCases(state.Cluster, filepath.Join(t.TempDir(), "connected"), tc.listed)})
			var stdout bytes.Buffer
			r := newRunner(Options{Repository: state.Repository, Out: &stdout})
			r.engine = "docker"
			r.env[developmentImageRegistrySetting] = registryTestContainer
			r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] = registryTestRuntime
			if err := r.selectDevelopmentImageRegistry(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := r.importDevelopmentImage(context.Background(), state, registryTestRuntime); err == nil || !strings.Contains(err.Error(), "not attached") {
				t.Fatalf("pulled before the registry was attached: %v", err)
			}
			if err := r.attachDevelopmentImageRegistry(context.Background(), state); err != nil {
				t.Fatal(err)
			}
			got, err := r.importDevelopmentImage(context.Background(), state, registryTestRuntime)
			calls := commands()
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q, got %v", tc.want, err)
				}
				// A failed pull leaves the registry attached for the caller's detach.
				if countCalls(calls, disconnect) != 0 {
					t.Fatalf("a failed pull detached the registry: %v", calls)
				}
			} else {
				if err != nil || got != registryTestRuntime {
					t.Fatalf("got %q, %v\n%s", got, err, strings.Join(calls, "\n"))
				}
				// The only selected image is in the node: the pull detached the registry.
				if calls[len(calls)-1] != disconnect {
					t.Fatalf("the last pull did not detach the registry: %v", calls)
				}
			}
			for range 2 {
				if err := r.detachDevelopmentImageRegistry(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			calls = commands()
			for _, call := range calls {
				if strings.Contains(call, " image save ") || strings.HasPrefix(call, "k3d ") || strings.Contains(call, "docker tag ") {
					t.Fatalf("a registry image took the archive path: %v", calls)
				}
			}
			if countCalls(calls, disconnect) != 1 {
				t.Fatalf("expected one disconnect: %v", calls)
			}
			// One pull from the container port, then one tag to the selected name,
			// then the inventory check. The fixture lists the selected name whatever
			// was tagged, so the tag itself is pinned here.
			ctr := "docker exec k3d-" + state.Cluster + "-server-0 ctr -n k8s.io images "
			source := registryTestAddress + ":5000/oce-smoke/runtime@" + profileTestDigest
			pull := slices.Index(calls, ctr+"pull --plain-http --platform linux/amd64 "+source)
			tag := slices.Index(calls, ctr+"tag "+source+" "+registryTestRuntime)
			if pull < 0 || tag <= pull || slices.Index(calls, ctr+"list") <= tag || countCalls(calls, ctr+"pull ") != 1 || countCalls(calls, ctr+"tag ") != 1 {
				t.Fatalf("expected one pull from the container port, one tag to the selected name, then the inventory check: %v", calls)
			}
			if strings.Contains(stdout.String(), "progress that stays hidden") {
				t.Fatalf("pull progress reached the output: %s", &stdout)
			}
		})
	}
}

func TestDevelopmentImageRegistryDetachesAfterTheLastSelectedImage(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	controller := "127.0.0.1:15001/oce-smoke/controller@" + profileTestDigest
	disconnect := "docker network disconnect k3d-" + state.Cluster + " " + registryTestContainer
	commands := fakeProfileCommands(t, map[string]string{"docker": registryPullCases(state.Cluster, filepath.Join(t.TempDir(), "connected"), registryListed(registryTestRuntime, controller))})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "docker"
	r.env[developmentImageRegistrySetting] = registryTestContainer
	r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] = registryTestRuntime
	r.env["OCC_DEVELOPMENT_CONTROLLER_IMAGE"] = controller
	if err := r.selectDevelopmentImageRegistry(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.attachDevelopmentImageRegistry(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	if _, err := r.importDevelopmentImage(context.Background(), state, registryTestRuntime); err != nil {
		t.Fatal(err)
	}
	if countCalls(commands(), disconnect) != 0 {
		t.Fatalf("detached while the controller image was still to pull: %v", commands())
	}
	if _, err := r.importDevelopmentImage(context.Background(), state, controller); err != nil {
		t.Fatal(err)
	}
	calls := commands()
	if countCalls(calls, disconnect) != 1 || calls[len(calls)-1] != disconnect {
		t.Fatalf("the last selected image did not detach the registry: %v", calls)
	}
}

func TestDevelopmentImageRegistryAttachEdgeCases(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	network := "k3d-" + state.Cluster
	inspect := `"container inspect --format {{with index .NetworkSettings.Networks \"` + network + `\"}}{{.IPAddress}}{{end}} ` + registryTestContainer + `")`
	newRegistry := func() *runner {
		r := newRunner(Options{Repository: state.Repository})
		r.engine = "docker"
		r.imageRegistry = &developmentImageRegistry{container: registryTestContainer, ports: map[string]string{"127.0.0.1:15001": "5000"}, pending: 1}
		return r
	}
	t.Run("an existing connection is reused", func(t *testing.T) {
		commands := fakeProfileCommands(t, map[string]string{"docker": inspect + ` echo ` + registryTestAddress + ` ;;
"network disconnect ` + network + ` ` + registryTestContainer + `") ;;`})
		r := newRegistry()
		if err := r.attachDevelopmentImageRegistry(context.Background(), state); err != nil || r.imageRegistry.address != registryTestAddress {
			t.Fatalf("%v %v", err, commands())
		}
		if countCalls(commands(), "docker network connect ") != 0 {
			t.Fatalf("connected twice: %v", commands())
		}
		if err := r.detachDevelopmentImageRegistry(context.Background()); err != nil || countCalls(commands(), "docker network disconnect ") != 1 {
			t.Fatalf("the reused connection was not detached: %v %v", err, commands())
		}
	})
	t.Run("no IPv4 address on the network", func(t *testing.T) {
		marker := filepath.Join(t.TempDir(), "connected")
		commands := fakeProfileCommands(t, map[string]string{"docker": `"network connect ` + network + ` ` + registryTestContainer + `") : > ` + shellQuote(marker) + ` ;;
` + inspect + ` if [ -f ` + shellQuote(marker) + ` ]; then echo fd00::5; fi ;;
"network disconnect ` + network + ` ` + registryTestContainer + `") /bin/rm ` + shellQuote(marker) + ` ;;`})
		r := newRegistry()
		err := r.attachDevelopmentImageRegistry(context.Background(), state)
		if err == nil || !strings.Contains(err.Error(), "no IPv4 address") {
			t.Fatalf("want the address refusal, got %v", err)
		}
		if err := r.detachDevelopmentImageRegistry(context.Background()); err != nil || countCalls(commands(), "docker network disconnect ") != 1 {
			t.Fatalf("a failed attach was not detached: %v %v", err, commands())
		}
	})
	t.Run("a detach after the caller's context ended", func(t *testing.T) {
		// An interrupted start cancels the context before the deferred detach
		// runs; the detach must still remove the registry from the network.
		commands := fakeProfileCommands(t, map[string]string{"docker": registryPullCases(state.Cluster, filepath.Join(t.TempDir(), "connected"), "")})
		r := newRegistry()
		if err := r.attachDevelopmentImageRegistry(context.Background(), state); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := r.detachDevelopmentImageRegistry(ctx); err != nil || countCalls(commands(), "docker network disconnect ") != 1 || r.imageRegistry.network != "" {
			t.Fatalf("a cancelled start left the registry attached: %v %v", err, commands())
		}
	})
	t.Run("a connect that fails without connecting", func(t *testing.T) {
		commands := fakeProfileCommands(t, map[string]string{"docker": `"network connect ` + network + ` ` + registryTestContainer + `") exit 1 ;;
` + inspect + ` ;;`})
		r := newRegistry()
		if err := r.attachDevelopmentImageRegistry(context.Background(), state); err == nil {
			t.Fatal("a failed connect was reported as attached")
		}
		if err := r.detachDevelopmentImageRegistry(context.Background()); err != nil || countCalls(commands(), "docker network disconnect ") != 0 {
			t.Fatalf("detach acted on a registry that never joined: %v %v", err, commands())
		}
	})
	t.Run("a non-Linux image", func(t *testing.T) {
		commands := fakeProfileCommands(t, map[string]string{"docker": `"image inspect --format {{.Os}}/{{.Architecture}} ` + registryTestRuntime + `") echo windows/amd64 ;;`})
		r := newRegistry()
		r.imageRegistry.network, r.imageRegistry.address = network, registryTestAddress
		_, err := r.importDevelopmentImage(context.Background(), state, registryTestRuntime)
		if err == nil || !strings.Contains(err.Error(), "must contain a Linux platform") || countCalls(commands(), "docker exec ") != 0 {
			t.Fatalf("want the platform refusal before any node command, got %v %v", err, commands())
		}
	})
}

func TestDevelopmentImageImportKeepsTheArchivePathForOtherImages(t *testing.T) {
	// The PostgreSQL image is not in the registry: with the registry selected it
	// still takes the archive export and import, through the k3d stream.
	state := kubernetesOnlyOpenShellState(t)
	image := "ghcr.io/openclaw/runtime@" + profileTestDigest
	sum := sha256.Sum256([]byte(image))
	staging := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], state.Cluster)
	reference := "docker.io/" + strings.TrimSuffix(staging, ":"+state.Cluster) + "@" + profileTestDigest
	server := "k3d-" + state.Cluster + "-server-0"
	commands := fakeProfileCommands(t, map[string]string{
		"docker": `"image inspect ` + staging + `") exit 1 ;;
"tag ` + image + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + staging + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + staging + `") echo linux/amd64 ;;
"image save --platform linux/amd64 --output "*" ` + staging + `") printf archive > "$6" ;;
"exec ` + server + ` ctr -n k8s.io images list") echo "` + staging + ` application/vnd.oci.image.manifest.v1+json ` + profileTestDigest + `" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + staging + ` ` + reference + `") ;;
"image rm ` + staging + `") ;;`,
		"k3d": `"image import --mode direct "*" -c ` + state.Cluster + `") ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "docker"
	r.imageRegistry = &developmentImageRegistry{container: registryTestContainer, ports: map[string]string{"127.0.0.1:15001": "5000"}, network: "k3d-" + state.Cluster, address: registryTestAddress, pending: 1}
	got, err := r.importDevelopmentImage(context.Background(), state, image)
	if err != nil || got != reference {
		t.Fatalf("got %q, %v\n%s", got, err, strings.Join(commands(), "\n"))
	}
	if !slices.ContainsFunc(commands(), func(call string) bool { return strings.HasPrefix(call, "k3d image import --mode direct ") }) {
		t.Fatalf("the archive was not imported: %v", commands())
	}
}

// TestK3dRegistryAttachmentOrdering runs the Kubernetes-only lifecycle with
// the registry selected until the Codex check refuses: the registry joins the
// cluster network only after the cluster exists, the runtime image is pulled
// rather than exported, and the registry leaves the network before the
// rollback deletes the cluster (and with it the network).
func TestK3dRegistryAttachmentOrdering(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	cluster := "occ-dev-registry"
	controllerImage := "127.0.0.1:15001/oce-smoke/controller@" + profileTestDigest
	imageCases, imageList := "", registryListed(registryTestRuntime, controllerImage)
	sum := sha256.Sum256([]byte(developmentPostgres))
	staging := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], cluster)
	imageCases += `"image inspect ` + staging + `") exit 1 ;;
"tag ` + developmentPostgres + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + staging + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + staging + `") echo linux/amd64 ;;
"exec k3d-` + cluster + `-server-0 ctr -n k8s.io images tag ` + staging + ` "*) ;;
"image rm ` + staging + `") ;;
`
	imageList += staging + " application/vnd.oci.image.manifest.v1+json " + profileTestDigest + "\n"
	for _, key := range []string{"DOCKER_CONTEXT", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE", "OCC_DEVELOPMENT_OPENSHELL_HELM_CHART", "OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART", "OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST"} {
		t.Setenv(key, "")
	}
	for key, value := range map[string]string{
		"OCC_DEVELOPMENT_STATE_DIRECTORY":                   state,
		"OCC_DEVELOPMENT_KUBERNETES_CLUSTER":                cluster,
		"OCC_DEVELOPMENT_KUBERNETES_NAMESPACE":              "oce-system",
		"OCC_DEVELOPMENT_CONTAINER_ENGINE":                  "docker",
		"DOCKER_HOST":                                       "unix:///fixture/docker.sock",
		"OCC_DEVELOPMENT_K3D_DNS_RESOLVER":                  "k3d",
		"OCC_DEVELOPMENT_CONTROLLER_IMAGE":                  controllerImage,
		"OCC_KUBERNETES_RUNTIME_IMAGE":                      registryTestRuntime,
		developmentImageRegistrySetting:                     registryTestContainer,
		"OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS":           "41",
		"OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT": "5",
		"OPENCLAW_DEV_PORT":                                 "3000",
		"OCC_DEVELOPMENT_KUBERNETES_API_PORT":               "6443",
		"OCC_DEVELOPMENT_BROWSER_PORT":                      "8443",
	} {
		t.Setenv(key, value)
	}
	previousTransport := http.DefaultTransport
	http.DefaultTransport = &k3dOrderingTransport{}
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	previousRetry := developmentRoutingManifestRetry
	developmentRoutingManifestRetry.attempts = 1
	t.Cleanup(func() { developmentRoutingManifestRetry = previousRetry })
	t.Setenv("PATH", t.TempDir())
	commands := fakeProfileCommands(t, map[string]string{
		"git": `"rev-parse --verify HEAD") echo 0123456789abcdef0123456789abcdef01234567 ;;`,
		"docker": `"version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker"}}' ;;
"info") ;;
"image inspect --format {{ index .Config.Labels "*) echo 0123456789abcdef0123456789abcdef01234567 ;;
"exec k3d-` + cluster + `-server-0 nslookup registry-1.docker.io") ;;
"image inspect ` + registryTestRuntime + `") ;;
"image inspect ` + controllerImage + `") ;;
"image inspect ` + developmentPostgres + `") ;;
` + imageCases + `"image save --platform linux/amd64 --output "*) ;;
` + strings.ReplaceAll(registryPullCases(cluster, filepath.Join(root, "connected"), imageList), `"network disconnect k3d-`+cluster+` `+registryTestContainer+`") `,
			`"network disconnect k3d-`+cluster+` `+registryTestContainer+`") [ -f `+shellQuote(filepath.Join(root, "deleted"))+` ] && exit 98; `),
		"k3d": `"cluster list -o json") if [ -f ` + shellQuote(filepath.Join(root, "created")) + ` ]; then echo '[{"name":"` + cluster + `"}]'; else echo '[]'; fi ;;
"cluster create ` + cluster + ` "*) : > ` + shellQuote(filepath.Join(root, "created")) + ` ;;
"kubeconfig get ` + cluster + `") printf '%s\n' 'contexts:' '- name: k3d-` + cluster + `' '  context:' '    cluster: owned' 'clusters:' '- name: owned' '  cluster:' '    server: https://127.0.0.1:6443' ;;
"image import --mode direct "*) ;;
"cluster delete ` + cluster + `") : > ` + shellQuote(filepath.Join(root, "deleted")) + ` ;;`,
		"kubectl": `"--kubeconfig "*" --context k3d-` + cluster + ` get --raw=/version") ;;
"create -f "*) while :; do :; done ;;`,
		"helm": `"show chart "*) exit 45 ;;`,
		"node": `"scripts/prepare-development-codex-seccomp.mjs "*) echo 'sandbox fixture refused' >&2; exit 42 ;;`,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := upK3d(ctx, Options{Repository: root, Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, "none", nil, nil)
	calls := commands()
	// The rollback detaches the registry and deletes the cluster cleanly.
	if err == nil || !strings.Contains(err.Error(), "dedicated Codex sandbox preparation failed") || strings.Contains(err.Error(), "rollback incomplete") || ctx.Err() != nil {
		t.Fatalf("want the Codex refusal, got %v; commands: %v", err, calls)
	}
	if _, err := os.Lstat(state); !os.IsNotExist(err) {
		t.Fatalf("the rollback kept its state: %v", err)
	}
	index := func(prefix string) int {
		for i, call := range calls {
			if strings.HasPrefix(call, prefix) {
				return i
			}
		}
		return -1
	}
	previous := -1
	for _, stage := range []string{
		"docker container inspect --format {{json .NetworkSettings.Ports}} " + registryTestContainer,
		"k3d cluster create " + cluster + " ",
		"docker network connect k3d-" + cluster + " " + registryTestContainer,
		"docker exec k3d-" + cluster + "-server-0 ctr -n k8s.io images pull --plain-http --platform linux/amd64 " + registryTestAddress + ":5000/oce-smoke/runtime@" + profileTestDigest,
		"node scripts/prepare-development-codex-seccomp.mjs ",
		"docker network disconnect k3d-" + cluster + " " + registryTestContainer,
		"k3d cluster delete " + cluster,
	} {
		i := index(stage)
		if i <= previous {
			t.Fatalf("stage %q out of order or absent: %v", stage, calls)
		}
		previous = i
	}
	for _, call := range calls {
		if strings.Contains(call, "image save") && !strings.Contains(call, staging) {
			t.Fatalf("a registry image was exported: %s", call)
		}
	}
}

// registryTestServer is a loopback HTTP registry serving fixed paths. It
// records every request path.
type registryTestServer struct {
	host   string
	mu     sync.Mutex
	routes map[string]registryTestResponse
	seen   []string
}

type registryTestResponse struct {
	status int
	body   []byte
	header map[string]string
}

func newRegistryTestServer(t *testing.T) *registryTestServer {
	t.Helper()
	s := &registryTestServer{routes: map[string]registryTestResponse{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		s.mu.Lock()
		s.seen = append(s.seen, request.URL.Path)
		route, ok := s.routes[request.URL.Path]
		s.mu.Unlock()
		// A registry answers a manifest request only for the media types it accepts.
		if strings.Contains(request.URL.Path, "/manifests/") && !strings.Contains(request.Header.Get("Accept"), "application/vnd.oci.image.manifest.v1+json") {
			http.NotFound(w, request)
			return
		}
		if !ok {
			http.NotFound(w, request)
			return
		}
		for key, value := range route.header {
			w.Header().Set(key, value)
		}
		w.WriteHeader(route.status)
		_, _ = w.Write(route.body)
	}))
	t.Cleanup(server.Close)
	s.host = strings.TrimPrefix(server.URL, "http://")
	return s
}

func (s *registryTestServer) requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.seen)
}

func (s *registryTestServer) registry() *developmentImageRegistry {
	return &developmentImageRegistry{container: registryTestContainer, ports: map[string]string{s.host: "5000"}, pending: 1}
}

func registryTestSum(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// serveImage publishes a manifest naming config under repository path and
// returns the digest-pinned reference that selects it.
func (s *registryTestServer) serveImage(path, mediaType string, config []byte) string {
	manifest := []byte(`{"schemaVersion":2,"mediaType":"` + mediaType + `","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"` + registryTestSum(config) + `","size":` + fmt.Sprint(len(config)) + `},"layers":[]}`)
	digest := registryTestSum(manifest)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.routes["/v2/"+path+"/manifests/"+digest] = registryTestResponse{status: http.StatusOK, body: manifest}
	s.routes["/v2/"+path+"/blobs/"+registryTestSum(config)] = registryTestResponse{status: http.StatusOK, body: config}
	return s.host + "/" + path + "@" + digest
}

func registryTestConfig(platform, revision string) []byte {
	os, architecture, _ := strings.Cut(platform, "/")
	return []byte(`{"os":"` + os + `","architecture":"` + architecture + `","config":{"Labels":{"org.opencontainers.image.revision":"` + revision + `"}},"rootfs":{"type":"layers","diff_ids":[]}}`)
}

const registryTestRevision = "0123456789abcdef0123456789abcdef01234567"

func TestDevelopmentRegistryImageRead(t *testing.T) {
	const ociManifest = "application/vnd.oci.image.manifest.v1+json"
	for name, tc := range map[string]struct {
		mediaType string
		config    []byte
		// tamper changes what the registry serves for the image.
		tamper func(s *registryTestServer, reference string)
		want   string
	}{
		"OCI image manifest": {mediaType: ociManifest, config: registryTestConfig("linux/arm64", registryTestRevision)},
		"Docker image manifest": {
			mediaType: "application/vnd.docker.distribution.manifest.v2+json", config: registryTestConfig("linux/arm64", registryTestRevision),
		},
		"manifest bytes that do not match the selected digest": {
			mediaType: ociManifest, config: registryTestConfig("linux/arm64", registryTestRevision),
			tamper: func(s *registryTestServer, reference string) {
				path := "/v2/oce-smoke/runtime/manifests/" + strings.SplitN(reference, "@", 2)[1]
				route := s.routes[path]
				route.body = append(slices.Clone(route.body), ' ')
				s.routes[path] = route
			},
			want: "content does not match its digest",
		},
		"a config that does not match the manifest": {
			mediaType: ociManifest, config: registryTestConfig("linux/arm64", registryTestRevision),
			tamper: func(s *registryTestServer, _ string) {
				for path, route := range s.routes {
					if strings.Contains(path, "/blobs/") {
						route.body = registryTestConfig("linux/arm64", strings.Repeat("f", 40))
						s.routes[path] = route
					}
				}
			},
			want: "content does not match its digest",
		},
		"an image index": {mediaType: "application/vnd.oci.image.index.v1+json", config: registryTestConfig("linux/arm64", registryTestRevision), want: "no single image manifest"},
		"an index without a media type, naming a config": {
			mediaType: ociManifest, config: registryTestConfig("linux/arm64", registryTestRevision),
			tamper: func(s *registryTestServer, _ string) {
				index := []byte(`{"schemaVersion":2,"config":{"digest":"` + profileTestDigest + `"},"manifests":[]}`)
				s.routes["/v2/oce-smoke/index/manifests/"+registryTestSum(index)] = registryTestResponse{status: http.StatusOK, body: index}
			},
			want: "no single image manifest",
		},
		"a config without a platform":          {mediaType: ociManifest, config: []byte(`{"config":{"Labels":{}}}`), want: "invalid image config"},
		"a platform field holding a separator": {mediaType: ociManifest, config: registryTestConfig("linux/x/arm64", registryTestRevision), want: "invalid image config"},
		"an unknown image": {
			mediaType: ociManifest, config: registryTestConfig("linux/arm64", registryTestRevision),
			tamper: func(s *registryTestServer, _ string) { clear(s.routes) },
			want:   "HTTP 404",
		},
		"a redirect": {
			mediaType: ociManifest, config: registryTestConfig("linux/arm64", registryTestRevision),
			tamper: func(s *registryTestServer, reference string) {
				s.routes["/v2/oce-smoke/runtime/manifests/"+strings.SplitN(reference, "@", 2)[1]] = registryTestResponse{status: http.StatusFound, header: map[string]string{"Location": "http://example.invalid/"}}
			},
			want: "HTTP 302",
		},
		"an oversized manifest": {
			mediaType: ociManifest, config: registryTestConfig("linux/arm64", registryTestRevision),
			tamper: func(s *registryTestServer, reference string) {
				s.routes["/v2/oce-smoke/runtime/manifests/"+strings.SplitN(reference, "@", 2)[1]] = registryTestResponse{status: http.StatusOK, body: bytes.Repeat([]byte(" "), developmentRegistryReadLimit+1)}
			},
			want: "content larger than",
		},
	} {
		t.Run(name, func(t *testing.T) {
			server := newRegistryTestServer(t)
			reference := server.serveImage("oce-smoke/runtime", tc.mediaType, tc.config)
			if tc.tamper != nil {
				tc.tamper(server, reference)
			}
			r := newRunner(Options{})
			r.imageRegistry = server.registry()
			if name == "an index without a media type, naming a config" {
				reference = server.host + "/oce-smoke/index@" + registryTestSum([]byte(`{"schemaVersion":2,"config":{"digest":"`+profileTestDigest+`"},"manifests":[]}`))
			}
			got, err := r.readRegistryImage(context.Background(), reference)
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q, got %v", tc.want, err)
				}
				return
			}
			if err != nil || got.Platform != "linux/arm64" || got.Labels["org.opencontainers.image.revision"] != registryTestRevision {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
	t.Run("an image the registry does not serve", func(t *testing.T) {
		server := newRegistryTestServer(t)
		r := newRunner(Options{})
		r.imageRegistry = server.registry()
		for _, image := range []string{"ghcr.io/openclaw/runtime@" + profileTestDigest, server.host + "/oce-smoke/runtime:latest"} {
			if _, err := r.readRegistryImage(context.Background(), image); err == nil || !strings.Contains(err.Error(), "not pinned to the development image registry") {
				t.Fatalf("%s: %v", image, err)
			}
		}
		if len(server.requests()) != 0 {
			t.Fatalf("contacted the registry: %v", server.requests())
		}
	})
}

func TestDevelopmentImageRevisionsReadImagesTheEngineLacksFromTheRegistry(t *testing.T) {
	server := newRegistryTestServer(t)
	controller := server.serveImage("oce-smoke/controller", "application/vnd.oci.image.manifest.v1+json", registryTestConfig("linux/amd64", registryTestRevision))
	runtime := server.serveImage("oce-smoke/runtime", "application/vnd.oci.image.manifest.v1+json", registryTestConfig("linux/amd64", registryTestRevision))
	stale := server.serveImage("oce-smoke/stale", "application/vnd.oci.image.manifest.v1+json", registryTestConfig("linux/amd64", strings.Repeat("f", 40)))
	missing := server.host + "/oce-smoke/missing@" + profileTestDigest
	for name, tc := range map[string]struct {
		controller, runtime string
		local               bool
		registry            bool
		want                string
	}{
		"both in the registry only":               {controller: controller, runtime: runtime, registry: true},
		"both local: the registry is not read":    {controller: controller, runtime: runtime, registry: true, local: true},
		"a registry image from another revision":  {controller: controller, runtime: stale, registry: true, want: "selected image revision does not match checkout"},
		"an image in neither":                     {controller: controller, runtime: missing, registry: true, want: "must exist locally or in the development image registry"},
		"no registry selected: local engine only": {controller: controller, runtime: runtime, want: "selected image must exist locally and expose its source revision"},
	} {
		t.Run(name, func(t *testing.T) {
			inspect := ""
			if tc.local {
				inspect = `"image inspect --format {{ index .Config.Labels \"org.opencontainers.image.revision\" }} "*) echo ` + registryTestRevision + ` ;;`
			}
			fakeProfileCommands(t, map[string]string{
				"git":    `"rev-parse --verify HEAD") echo ` + registryTestRevision + ` ;;`,
				"docker": inspect,
			})
			r := newRunner(Options{})
			r.engine = "docker"
			r.env["OCC_DEVELOPMENT_CONTROLLER_IMAGE"] = tc.controller
			r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] = tc.runtime
			if tc.registry {
				r.imageRegistry = server.registry()
			}
			before := len(server.requests())
			err := r.validateDevelopmentImageRevisions(context.Background())
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q, got %v", tc.want, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if read := len(server.requests()) - before; (read != 0) == tc.local {
				t.Fatalf("registry reads %d with local images %v", read, tc.local)
			}
		})
	}
}

func TestDevelopmentRegistryImageWithoutALocalCopy(t *testing.T) {
	server := newRegistryTestServer(t)
	runtime := server.serveImage("oce-smoke/runtime", "application/vnd.oci.image.manifest.v1+json", registryTestConfig("linux/arm64", registryTestRevision))
	t.Run("an explicit selection exists in the registry", func(t *testing.T) {
		fakeProfileCommands(t, map[string]string{"docker": ""})
		r := newRunner(Options{})
		r.engine = "docker"
		r.imageRegistry = server.registry()
		if err := r.requireSelectedDevelopmentImage(context.Background(), "runtime", runtime); err != nil {
			t.Fatal(err)
		}
		err := r.requireSelectedDevelopmentImage(context.Background(), "runtime", server.host+"/oce-smoke/runtime@"+profileTestDigest)
		if err == nil || !strings.Contains(err.Error(), "must already exist locally or in the development image registry") || !strings.Contains(err.Error(), "HTTP 404") {
			t.Fatalf("want the registry refusal with its cause, got %v", err)
		}
		r.imageRegistry = nil
		err = r.requireSelectedDevelopmentImage(context.Background(), "runtime", runtime)
		if err == nil || err.Error() != "explicitly selected runtime image must already exist locally: "+runtime {
			t.Fatalf("want the local-only refusal, got %v", err)
		}
	})
	t.Run("the node pulls it for the registry's platform", func(t *testing.T) {
		state := kubernetesOnlyOpenShellState(t)
		_, digest, _ := strings.Cut(runtime, "@")
		server0 := "k3d-" + state.Cluster + "-server-0"
		commands := fakeProfileCommands(t, map[string]string{"docker": `"exec ` + server0 + ` ctr -n k8s.io images pull --plain-http --platform linux/arm64 ` + registryTestAddress + `:5000/oce-smoke/runtime@` + digest + `") ;;
"exec ` + server0 + ` ctr -n k8s.io images tag "*) ;;
"exec ` + server0 + ` ctr -n k8s.io images list") echo "` + runtime + ` application/vnd.oci.image.manifest.v1+json ` + digest + `" ;;
"network disconnect "*) ;;
"container inspect "*) echo ` + registryTestAddress + ` ;;`})
		r := newRunner(Options{Repository: state.Repository})
		r.engine = "docker"
		r.imageRegistry = server.registry()
		r.imageRegistry.network, r.imageRegistry.address = "k3d-"+state.Cluster, registryTestAddress
		got, err := r.importDevelopmentImage(context.Background(), state, runtime)
		if err != nil || got != runtime {
			t.Fatalf("got %q, %v\n%s", got, err, strings.Join(commands(), "\n"))
		}
	})
	t.Run("a non-Linux registry image is refused before any node command", func(t *testing.T) {
		state := kubernetesOnlyOpenShellState(t)
		windows := server.serveImage("oce-smoke/windows", "application/vnd.oci.image.manifest.v1+json", registryTestConfig("windows/amd64", registryTestRevision))
		commands := fakeProfileCommands(t, map[string]string{"docker": ""})
		r := newRunner(Options{Repository: state.Repository})
		r.engine = "docker"
		r.imageRegistry = server.registry()
		r.imageRegistry.network, r.imageRegistry.address = "k3d-"+state.Cluster, registryTestAddress
		_, err := r.importDevelopmentImage(context.Background(), state, windows)
		if err == nil || !strings.Contains(err.Error(), "must contain a Linux platform") || countCalls(commands(), "docker exec ") != 0 {
			t.Fatalf("want the platform refusal, got %v %v", err, commands())
		}
	})
}

// TestDevelopmentImageRegistryAttachmentIsRecorded pins the state.json record
// occ dev down relies on after a killed start: written before the connect,
// cleared once the registry is detached.
func TestDevelopmentImageRegistryAttachmentIsRecorded(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	network := "k3d-" + state.Cluster
	path := filepath.Join(state.directory, "state.json")
	marker := filepath.Join(t.TempDir(), "connected")
	// The connect fails unless state.json already names the attachment.
	cases := strings.Replace(registryPullCases(state.Cluster, marker, registryListed(registryTestRuntime)),
		`"network connect `+network+` `+registryTestContainer+`") `,
		`"network connect `+network+` `+registryTestContainer+`") grep -q '"imageRegistryNetwork":"`+network+`"' `+shellQuote(path)+` || exit 95; `, 1)
	for _, detach := range []string{"by the last pull", "by the caller"} {
		t.Run(detach, func(t *testing.T) {
			commands := fakeProfileCommands(t, map[string]string{"docker": cases})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			r.env[developmentImageRegistrySetting] = registryTestContainer
			r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] = registryTestRuntime
			if err := r.selectDevelopmentImageRegistry(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := r.attachDevelopmentImageRegistry(context.Background(), state); err != nil {
				t.Fatalf("%v %v", err, commands())
			}
			recorded := readJSONFile(t, path)
			if recorded["imageRegistryContainer"] != registryTestContainer || recorded["imageRegistryNetwork"] != network || recorded["cluster"] != state.Cluster {
				t.Fatalf("the attachment was not recorded: %v", recorded)
			}
			if detach == "by the last pull" {
				if _, err := r.importDevelopmentImage(context.Background(), state, registryTestRuntime); err != nil {
					t.Fatal(err)
				}
			} else if err := r.detachDevelopmentImageRegistry(context.Background()); err != nil {
				t.Fatal(err)
			}
			if countCalls(commands(), "docker network disconnect ") != 1 {
				t.Fatalf("expected one disconnect: %v", commands())
			}
			cleared := readJSONFile(t, path)
			if _, ok := cleared["imageRegistryNetwork"]; ok || cleared["imageRegistryContainer"] != nil || cleared["cluster"] != state.Cluster {
				t.Fatalf("the detached attachment is still recorded: %v", cleared)
			}
		})
	}
}

// developmentDownFixture records a Kubernetes-only stack whose state.json
// names a registry attachment, as a start killed while attached leaves it.
func developmentDownFixture(t *testing.T, container, network string) string {
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
		Version: 3, Repository: root, ComputeDriver: "kubernetes", SandboxDriver: "none",
		DeploymentMode: "k3d", PlatformNamespace: "oce-system", APIPort: 3000, BrowserPort: 8443,
		ContainerEngine: "docker", Cluster: "occ-dev-recorded", DockerHost: "unix:///fixture/docker.sock",
		KeyPath: filepath.Join(directory, "initial-admin-service-key.json"), KeyOwned: true,
		ImageRegistryContainer: container, ImageRegistryNetwork: network, directory: directory,
	}
	if err := os.WriteFile(filepath.Join(directory, ".openclaw-development"), []byte(stateMarker), 0600); err != nil {
		t.Fatal(err)
	}
	if err := rewriteState(&state); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "kubernetes")
	t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
	t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", directory)
	return directory
}

func TestDevelopmentStateRegistryAttachment(t *testing.T) {
	for name, tc := range map[string]struct {
		container, network string
		valid              bool
	}{
		"none":                           {valid: true},
		"the recorded cluster's network": {container: registryTestContainer, network: "k3d-occ-dev-recorded", valid: true},
		"another cluster's network":      {container: registryTestContainer, network: "k3d-occ-dev-other"},
		"no container":                   {network: "k3d-occ-dev-recorded"},
		"no network":                     {container: registryTestContainer},
		"an option for a container":      {container: "--help", network: "k3d-occ-dev-recorded"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := readState(developmentDownFixture(t, tc.container, tc.network))
			if tc.valid != (err == nil) {
				t.Fatalf("valid %v, got %v", tc.valid, err)
			}
		})
	}
}

// TestDownDetachesARecordedRegistryAttachment covers a start killed while the
// registry was attached: down detaches it before k3d deletes the cluster,
// which keeps a network still in use.
func TestDownDetachesARecordedRegistryAttachment(t *testing.T) {
	network := "k3d-occ-dev-recorded"
	inspect := `"container inspect --format {{with index .NetworkSettings.Networks \"` + network + `\"}}{{.IPAddress}}{{end}} ` + registryTestContainer + `")`
	disconnect := "docker network disconnect " + network + " " + registryTestContainer
	k3d := `"cluster list -o json") echo '[{"name":"occ-dev-recorded"}]' ;;
"cluster delete occ-dev-recorded") ;;`
	for name, tc := range map[string]struct {
		docker, want string
		disconnects  int
		recorded     bool
	}{
		"attached": {docker: inspect + ` echo ` + registryTestAddress + ` ;;
"network disconnect ` + network + ` ` + registryTestContainer + `") ;;`, disconnects: 1, recorded: true},
		"already detached": {docker: inspect + ` ;;`, recorded: true},
		"container removed": {docker: inspect + ` echo 'Error: No such container' >&2; exit 1 ;;
"container ls --all --no-trunc --format {{.ID}} {{.Names}}") echo 0123abcd other-container,other-alias ;;`, recorded: true},
		"container present but unreadable": {docker: inspect + ` exit 1 ;;
"container ls --all --no-trunc --format {{.ID}} {{.Names}}") printf '%s\n' '0123abcd other-container' '4567cdef other-alias,` + registryTestContainer + `' ;;`, recorded: true, want: "detach the development image registry from " + network},
		"nothing recorded": {},
	} {
		t.Run(name, func(t *testing.T) {
			container, recordedNetwork := "", ""
			if tc.recorded {
				container, recordedNetwork = registryTestContainer, network
			}
			directory := developmentDownFixture(t, container, recordedNetwork)
			t.Setenv("DOCKER_HOST", "unix:///wrong.sock")
			t.Setenv("DOCKER_CONTEXT", "wrong-context")
			t.Setenv("DOCKER_TLS_VERIFY", "1")
			t.Setenv("DOCKER_CERT_PATH", "/wrong-certs")
			volumeCommand := "docker volume ls --filter label=k3d.cluster=occ-dev-recorded --format {{.Name}}"
			volumeCase := `"volume ls --filter label=k3d.cluster=occ-dev-recorded --format {{.Name}}")
[ "$DOCKER_HOST" = unix:///fixture/docker.sock ] || exit 91
[ -z "$DOCKER_CONTEXT$DOCKER_TLS_VERIFY$DOCKER_CERT_PATH" ] || exit 92
;;`
			commands := fakeProfileCommands(t, map[string]string{"docker": tc.docker + "\n" + volumeCase, "k3d": k3d})
			// Restrict lookup to these inert executables, including on unexpected calls.
			t.Setenv("PATH", strings.Split(os.Getenv("PATH"), string(os.PathListSeparator))[0])
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := Down(ctx, Options{Repository: filepath.Dir(directory), Out: &bytes.Buffer{}, Err: &bytes.Buffer{}})
			calls := commands()
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "preserving") {
					t.Fatalf("want %q, got %v", tc.want, err)
				}
				// The state stays for a retry of down, which detaches first again.
				if _, err := readState(directory); err != nil {
					t.Fatalf("the recovery state was lost: %v", err)
				}
			} else if err != nil {
				t.Fatalf("%v %v", err, calls)
			}
			volumeCalls := 0
			registryCalls := 0
			for _, call := range calls {
				if call == volumeCommand {
					volumeCalls++
				} else if strings.HasPrefix(call, "docker ") {
					registryCalls++
				}
			}
			wantVolumeCalls := 1
			if tc.want != "" {
				wantVolumeCalls = 0
			}
			if volumeCalls != wantVolumeCalls {
				t.Fatalf("want %d volume observations, got %d: %v", wantVolumeCalls, volumeCalls, calls)
			}
			if countCalls(calls, disconnect) != tc.disconnects || registryCalls > 0 && !tc.recorded {
				t.Fatalf("unexpected registry commands: %v", calls)
			}
			// The delete runs only after any disconnect. A failed detach keeps
			// the cluster, whose delete would keep the network still in use.
			i := slices.Index(calls, "k3d cluster delete occ-dev-recorded")
			if tc.want != "" {
				if i >= 0 {
					t.Fatalf("deleted the cluster with the registry still attached: %v", calls)
				}
			} else if i < 0 || slices.Index(calls, volumeCommand) < i || (tc.disconnects > 0 && slices.Index(calls, disconnect) > i) {
				t.Fatalf("the registry was not detached before the cluster delete: %v", calls)
			}
		})
	}
}

func TestContainerListed(t *testing.T) {
	listing := "0123456789abcdef first-registry\nfedcba9876543210 other,oce-registry\n"
	for container, want := range map[string]bool{
		"first-registry":   true,
		"oce-registry":     true,
		"fedcba98":         true,
		"0123456789abcdef": true,
		"registry":         false,
		"other-registry":   false,
		"abcdef":           false,
	} {
		if got := containerListed(listing, container); got != want {
			t.Errorf("containerListed(%q) = %v, want %v", container, got, want)
		}
	}
}
