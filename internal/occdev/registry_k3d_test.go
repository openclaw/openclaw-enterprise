package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	registryTestContainer = "oce-first-agent-smoke-registry"
	registryTestPorts     = `{"5000/tcp":[{"HostIp":"127.0.0.1","HostPort":"5000"}]}`
	registryTestRuntime   = "127.0.0.1:5000/oce-smoke/runtime@" + profileTestDigest
	registryTestAddress   = "172.18.0.5"
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
		"loopback and another address": {
			ports:   `{"5000/tcp":[{"HostIp":"127.0.0.1","HostPort":"5000"},{"HostIp":"::","HostPort":"5000"}]}`,
			runtime: registryTestRuntime, want: "must publish its ports on 127.0.0.1 only",
		},
		"stopped container": {ports: `{}`, runtime: registryTestRuntime, want: "publishes no TCP port on 127.0.0.1"},
		"tagged runtime": {
			ports: registryTestPorts, runtime: "127.0.0.1:5000/oce-smoke/runtime:latest",
			want: "no selected controller, runtime or repository image is pinned by digest",
		},
		"another published port": {
			ports: registryTestPorts, runtime: "127.0.0.1:5001/oce-smoke/runtime@" + profileTestDigest,
			want: "no selected controller, runtime or repository image is pinned by digest",
		},
		"another registry": {
			ports: registryTestPorts, runtime: "ghcr.io/openclaw/runtime@" + profileTestDigest,
			want: "no selected controller, runtime or repository image is pinned by digest",
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
				if err != nil || r.imageRegistry == nil || r.imageRegistry.ports["127.0.0.1:5000"] != "5000" {
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
	registry := &developmentImageRegistry{ports: map[string]string{"127.0.0.1:5000": "5000"}}
	for image, want := range map[string]bool{
		registryTestRuntime: true,
		"127.0.0.1:5000/oce-smoke/runtime:tag@" + profileTestDigest: false,
		"127.0.0.1:5000/oce-smoke/runtime":                          false,
		"127.0.0.1:5000/oce-smoke/runtime@sha256:abc":               false,
		"127.0.0.1:5000@" + profileTestDigest:                       false,
		"localhost:5000/oce-smoke/runtime@" + profileTestDigest:     false,
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
// and pulling the runtime through it; listed is the node's image inventory.
func registryPullCases(cluster, listed string) string {
	server := "k3d-" + cluster + "-server-0"
	source := registryTestAddress + ":5000/oce-smoke/runtime@" + profileTestDigest
	return registryPortsCase(registryTestPorts) + `
"network connect k3d-` + cluster + ` ` + registryTestContainer + `") ;;
"container inspect --format {{with index .NetworkSettings.Networks \"k3d-` + cluster + `\"}}{{.IPAddress}}{{end}} ` + registryTestContainer + `") echo ` + registryTestAddress + ` ;;
"network disconnect k3d-` + cluster + ` ` + registryTestContainer + `") ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + registryTestRuntime + `") echo linux/amd64 ;;
"exec ` + server + ` ctr -n k8s.io images pull --plain-http --platform linux/amd64 ` + source + `") echo "progress that stays hidden" ;;
"exec ` + server + ` ctr -n k8s.io images tag ` + source + ` ` + registryTestRuntime + `") ;;
"exec ` + server + ` ctr -n k8s.io images list") printf '` + listed + `' ;;`
}

func TestDevelopmentImageImportPullsRegistryImagesByDigest(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	pulled := registryTestRuntime + " application/vnd.oci.image.manifest.v1+json " + profileTestDigest + "\n"
	for name, tc := range map[string]struct{ listed, want string }{
		"selected digest": {listed: pulled},
		"another digest": {
			listed: registryTestRuntime + " application/vnd.oci.image.manifest.v1+json sha256:" + hex64 + "\n",
			want:   "the pulled image does not match the selected digest",
		},
		"not listed": {listed: "", want: "the pulled image does not match the selected digest"},
	} {
		t.Run(name, func(t *testing.T) {
			commands := fakeProfileCommands(t, map[string]string{"docker": registryPullCases(state.Cluster, tc.listed)})
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
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q, got %v", tc.want, err)
				}
			} else if err != nil || got != registryTestRuntime {
				t.Fatalf("got %q, %v\n%s", got, err, strings.Join(commands(), "\n"))
			}
			for range 2 {
				if err := r.detachDevelopmentImageRegistry(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			calls := commands()
			disconnects := 0
			for _, call := range calls {
				if strings.Contains(call, " image save ") || strings.HasPrefix(call, "k3d ") || strings.Contains(call, "docker tag ") {
					t.Fatalf("a registry image took the archive path: %v", calls)
				}
				if strings.HasPrefix(call, "docker network disconnect ") {
					disconnects++
				}
			}
			if disconnects != 1 {
				t.Fatalf("expected one disconnect, got %d: %v", disconnects, calls)
			}
			if strings.Contains(stdout.String(), "progress that stays hidden") {
				t.Fatalf("pull progress reached the output: %s", &stdout)
			}
		})
	}
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
	r.imageRegistry = &developmentImageRegistry{container: registryTestContainer, ports: map[string]string{"127.0.0.1:5000": "5000"}, network: "k3d-" + state.Cluster, address: registryTestAddress}
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
	controllerImage := "127.0.0.1:5000/oce-smoke/controller@" + profileTestDigest
	imageCases, imageList := "", registryTestRuntime+" application/vnd.oci.image.manifest.v1+json "+profileTestDigest+"\n"
	sum := sha256.Sum256([]byte(developmentPostgres))
	staging := fmt.Sprintf("openclaw-development/import-%x:%s", sum[:6], cluster)
	imageCases += `"image inspect ` + staging + `") exit 1 ;;
"tag ` + developmentPostgres + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + staging + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + staging + `") echo linux/amd64 ;;
"exec k3d-` + cluster + `-server-0 ctr -n k8s.io images tag ` + staging + ` "*) ;;
"image rm ` + staging + `") ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + controllerImage + `") echo linux/amd64 ;;
"exec k3d-` + cluster + `-server-0 ctr -n k8s.io images pull --plain-http --platform linux/amd64 ` + registryTestAddress + `:5000/oce-smoke/controller@"*) ;;
"exec k3d-` + cluster + `-server-0 ctr -n k8s.io images tag ` + registryTestAddress + `:5000/oce-smoke/controller@"*) ;;
`
	imageList += staging + " application/vnd.oci.image.manifest.v1+json " + profileTestDigest + "\n"
	imageList += controllerImage + " application/vnd.oci.image.manifest.v1+json " + profileTestDigest + "\n"
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
` + strings.ReplaceAll(registryPullCases(cluster, imageList), `"network disconnect k3d-`+cluster+` `+registryTestContainer+`") ;;`,
			`"network disconnect k3d-`+cluster+` `+registryTestContainer+`") [ -f `+shellQuote(filepath.Join(root, "deleted"))+` ] && exit 98 ;;`),
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
	if err == nil || !strings.Contains(err.Error(), "dedicated Codex sandbox preparation failed") || ctx.Err() != nil {
		t.Fatalf("want the Codex refusal, got %v; commands: %v", err, calls)
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
