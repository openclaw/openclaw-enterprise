package occdev

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

// These tests cover the Kubernetes-only OpenShell profile one launcher step at a
// time. A full dev-up fixture would also have to stand in for the pinned routing
// controller downloads and network-policy probes, which only a real cluster proves
// (see dev-up-openshell-k3d-real and local-first-agent-openshell-k3d-real).

const profileTestDigest = "sha256:ca0bc15a045017ee20bfab682f1a561eca6e6c6ed7d021d20641da24aaa6dfb6"

// fakeProfileCommands puts fake binaries on PATH. Each records its arguments and
// answers only the listed cases, so a step that issues a new command fails.
func fakeProfileCommands(t *testing.T, scripts map[string]string) func() []string {
	t.Helper()
	directory := t.TempDir()
	log := filepath.Join(directory, "commands.log")
	if err := os.WriteFile(log, nil, 0600); err != nil {
		t.Fatal(err)
	}
	for name, cases := range scripts {
		body := "#!/bin/sh\nprintf '%s %s\\n' " + name + " \"$*\" >> " + shellQuote(log) +
			"\ncase \"$*\" in\n" + cases + "\n*) echo \"unexpected: " + name + " $*\" >&2; exit 97 ;;\nesac\n"
		if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() []string {
		data, err := os.ReadFile(log)
		if err != nil {
			t.Fatal(err)
		}
		if len(data) == 0 {
			return nil
		}
		return strings.Split(strings.TrimSpace(string(data)), "\n")
	}
}

func kubernetesOnlyOpenShellState(t *testing.T) *developmentState {
	t.Helper()
	repository, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return &developmentState{
		Version:           3,
		Repository:        repository,
		ComputeDriver:     "kubernetes",
		SandboxDriver:     "openshell",
		DeploymentMode:    "k3d",
		PlatformNamespace: "oce-system",
		APIPort:           3000,
		BrowserPort:       8443,
		Cluster:           "occ-dev-owned",
		ContainerEngine:   "docker",
		directory:         t.TempDir(),
	}
}

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

// jsonValue normalizes a literal through JSON so it compares with decoded files.
func jsonValue(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var normalized any
	if err := json.Unmarshal(data, &normalized); err != nil {
		t.Fatal(err)
	}
	return normalized
}

func TestKubernetesOnlyClusterPinsItsNodeAndKeepsVerifiedImages(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	args := kubernetesOnlyClusterArgs(state, 41, 6443, 5, "/state/openshell-admission.yaml")

	value := func(flag string) string {
		index := slices.Index(args, flag)
		if index < 0 || index+1 >= len(args) {
			t.Fatalf("missing %s in %v", flag, args)
		}
		return args[index+1]
	}
	if value("--image") != openShellK3sImage || !strings.Contains(openShellK3sImage, "@sha256:") {
		t.Fatalf("the k3d node must use the digest-pinned OpenShell k3s image: %v", args)
	}
	// A failed node must not leave cluster creation waiting without a deadline.
	if value("--timeout") != "41s" {
		t.Fatalf("unexpected cluster timeout: %v", args)
	}
	// Imported images use pull policy Never, so image GC must not drop them.
	for _, required := range []string{
		"--kubelet-arg=image-gc-high-threshold=100@server:*",
		"--kubelet-arg=image-gc-low-threshold=99@server:*",
		"127.0.0.1:3000:30080@loadbalancer",
		"127.0.0.1:8443:30081@loadbalancer",
		"/state/openshell-admission.yaml:" + openShellAdmissionContainerPath + ":ro@server:0",
	} {
		if !slices.Contains(args, required) {
			t.Fatalf("missing %q in %v", required, args)
		}
	}
	// The Kubernetes-only profile owns its k3d network; it never joins a Compose one.
	if slices.Contains(args, "--network") {
		t.Fatalf("the Kubernetes-only cluster must not join another network: %v", args)
	}
}

func TestKubernetesOnlyOpenShellInstallationUsesInClusterServices(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	assets := &openShellDevelopmentAssets{workspaceResources: []any{map[string]any{
		"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]any{"name": "openshell-sandbox"},
	}}}
	if err := writeInstallation(state, "runtime@"+profileTestDigest, assets, "10.43.0.50", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	endpoint := developmentRoutingEndpoint{gatewayNamespace: state.PlatformNamespace, hostname: developmentRoutingHostname(state)}
	if err := configureDevelopmentRouting(state, []string{"10.42.0.0/24"}, endpoint); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, required := range []string{
		"id: sandbox-openshell-development",
		"endpoint: http://openshell-gateway.oce-system.svc.cluster.local:8080",
		"requestTimeoutMs: 30000",
		"mode: inCluster",
		"workspaceMode: operator",
		"operatorWorkspaceResources:",
		"userNamespaces: false",
		`openshell.ai/openclaw-workspace: "true"`,
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("installation.yaml is missing %q", required)
		}
	}
	// In-cluster Drivers authenticate with their ServiceAccounts, not a host kubeconfig.
	if strings.Contains(text, "kubeconfigPath") {
		t.Fatal("the Kubernetes-only Installation must not reference a kubeconfig")
	}

	var installation struct {
		Drivers struct {
			CredentialGateway struct {
				Configuration struct {
					Binaries []string `yaml:"binaries"`
				} `yaml:"configuration"`
			} `yaml:"credential_gateway"`
			Sandbox struct {
				Configuration struct {
					StartupDelayMs int `yaml:"startupDelayMs"`
					Gateway        struct {
						NetworkPolicyResources []struct {
							Spec struct {
								PodSelector struct {
									MatchLabels map[string]string `yaml:"matchLabels"`
								} `yaml:"podSelector"`
							} `yaml:"spec"`
						} `yaml:"networkPolicyResources"`
					} `yaml:"gateway"`
				} `yaml:"configuration"`
			} `yaml:"sandbox"`
			Compute struct {
				Configuration struct {
					Network struct {
						ProviderHarness          map[string]any `yaml:"providerHarness"`
						GatewayTrustedProxyCidrs []string       `yaml:"gatewayTrustedProxyCidrs"`
					} `yaml:"network"`
					GatewayRouting map[string]any `yaml:"gatewayRouting"`
				} `yaml:"configuration"`
			} `yaml:"compute"`
		} `yaml:"drivers"`
	}
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	sandbox := installation.Drivers.Sandbox.Configuration
	if sandbox.StartupDelayMs != 30_000 {
		t.Fatalf("unexpected OpenShell startup delay: %d", sandbox.StartupDelayMs)
	}
	if !reflect.DeepEqual(installation.Drivers.CredentialGateway.Configuration.Binaries, []string{
		"/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
		"/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex",
		"/usr/local/bin/node",
	}) {
		t.Fatalf("unexpected OpenShell credential binary allowlist: %#v", installation.Drivers.CredentialGateway.Configuration.Binaries)
	}
	// Only OpenShell supervisors may use the tenant callback egress rule.
	if len(sandbox.Gateway.NetworkPolicyResources) == 0 || !reflect.DeepEqual(
		sandbox.Gateway.NetworkPolicyResources[0].Spec.PodSelector.MatchLabels,
		map[string]string{"openshell.ai/managed-by": "openshell", "openshell.ai/boundary-role": "supervisor"},
	) {
		t.Fatalf("unexpected OpenShell callback selector: %+v", sandbox.Gateway.NetworkPolicyResources)
	}
	compute := installation.Drivers.Compute.Configuration
	// Agent Gateways reach the OpenShell gateway that this profile installs in its
	// own platform Namespace.
	if !reflect.DeepEqual(compute.Network.ProviderHarness, map[string]any{
		"namespace": "oce-system",
		"podLabels": map[string]any{"app.kubernetes.io/name": "openshell", "app.kubernetes.io/instance": "openshell-gateway"},
		"address":   "10.43.0.50",
		"port":      8080,
	}) {
		t.Fatalf("unexpected provider Harness peer: %#v", compute.Network.ProviderHarness)
	}
	// OpenShell resolves policy hosts without search domains, so the route that
	// the workspace node uses must carry the Envoy Service's fully qualified name.
	if compute.GatewayRouting["hostname"] != developmentGatewayServiceName("oce-system")+".envoy-gateway-system.svc.cluster.local" ||
		compute.GatewayRouting["gatewayNamespace"] != "oce-system" {
		t.Fatalf("unexpected Gateway routing: %#v", compute.GatewayRouting)
	}
	if !reflect.DeepEqual(compute.Network.GatewayTrustedProxyCidrs, []string{"10.42.0.0/24"}) {
		t.Fatalf("unexpected trusted proxies: %v", compute.Network.GatewayTrustedProxyCidrs)
	}
}

func TestKubernetesOnlyOpenShellGatewayAdmitsOnlyItsClients(t *testing.T) {
	policies := developmentOpenShellNetworkPolicies("oce-system", map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"})
	items := jsonValue(t, policies).(map[string]any)["items"].([]any)
	var ingress map[string]any
	for _, item := range items {
		policy := item.(map[string]any)
		if policy["metadata"].(map[string]any)["name"] == "openclaw-development-openshell-ingress" {
			ingress = policy["spec"].(map[string]any)
		}
	}
	if ingress == nil {
		t.Fatal("missing OpenShell gateway ingress policy")
	}
	// The worker provisions Sandboxes, the API registers credential sources,
	// supervisors call back, and dedicated Agent Gateways relay to OpenShell-exposed
	// Harnesses. No other OCE component or tenant workload is admitted.
	expected := jsonValue(t, []any{
		map[string]any{"podSelector": map[string]any{
			"matchLabels": map[string]string{"app.kubernetes.io/name": "openclaw-enterprise", "app.kubernetes.io/instance": "openclaw-enterprise"},
			"matchExpressions": []any{map[string]any{
				"key": "app.kubernetes.io/component", "operator": "In", "values": []string{"api", "worker"},
			}},
		}},
		map[string]any{
			"namespaceSelector": map[string]any{
				"matchLabels":      map[string]string{"openshell.ai/openclaw-workspace": "true"},
				"matchExpressions": []any{map[string]any{"key": "openclaw.dev/namespace", "operator": "Exists"}},
			},
			"podSelector": map[string]any{"matchLabels": map[string]string{
				"openshell.ai/managed-by": "openshell", "openshell.ai/boundary-role": "supervisor",
			}},
		},
		map[string]any{
			"namespaceSelector": map[string]any{
				"matchExpressions": []any{map[string]any{"key": "openclaw.dev/gateway-namespace", "operator": "Exists"}},
			},
			"podSelector": map[string]any{"matchLabels": map[string]string{
				"app.kubernetes.io/managed-by": "openclaw-enterprise", "openclaw.dev/workload-role": "gateway",
			}},
		},
	})
	rules := ingress["ingress"].([]any)
	if len(rules) != 1 || !reflect.DeepEqual(rules[0].(map[string]any)["from"], expected) {
		t.Fatalf("unexpected OpenShell gateway ingress: %#v", rules)
	}
	if !reflect.DeepEqual(rules[0].(map[string]any)["ports"], jsonValue(t, []any{map[string]any{"protocol": "TCP", "port": 8080}})) {
		t.Fatalf("OpenShell gateway ingress must admit only its API port: %#v", rules)
	}
}

func TestKubernetesOnlyOpenShellGatewayInstallsImportedImagesBehindAClusterIP(t *testing.T) {
	for _, candidate := range []bool{false, true} {
		t.Run(fmt.Sprintf("candidate=%t", candidate), func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			root := t.TempDir()
			chart := filepath.Join(root, "chart")
			manifest := filepath.Join(root, "agent-sandbox.yaml")
			for _, path := range []string{chart, manifest} {
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Fixed source pins guard the released default; candidate digests deliberately
			// differ from the containerd manifests returned by the import fixture.
			sources := []string{
				"ghcr.io/nvidia/openshell/gateway:0.1.5@sha256:ca0bc15a045017ee20bfab682f1a561eca6e6c6ed7d021d20641da24aaa6dfb6",
				"ghcr.io/nvidia/openshell/sandbox:0.1.5@sha256:e9adf9ecde328122414ad2ee8c6fc5d5b389e4cf168daf4357c46f5a77d55851",
				"ghcr.io/nvidia/openshell/supervisor:0.1.5@sha256:fabcd01f656e9d23df4386f82e80b4f48b90f3452d7d5c58889007643a069161",
			}
			selection := candidateOpenShellEnvironment()
			if candidate {
				for i, component := range []string{"GATEWAY", "SANDBOX", "SUPERVISOR"} {
					sources[i] = selection["OCC_DEVELOPMENT_OPENSHELL_"+component+"_IMAGE"]
				}
			}
			var engineCases, inventory strings.Builder
			for i, component := range []string{"gateway", "sandbox", "supervisor"} {
				source := sources[i]
				staging := "openclaw-development/openshell-" + component + ":" + state.Cluster
				digest := "sha256:" + strings.Repeat(string(rune('a'+i)), 64)
				inspect := ":"
				if !candidate && i == 0 {
					// Released images may still be pulled when absent locally.
					inspect = "exit 1"
					fmt.Fprintf(&engineCases, "\"pull %s\") ;;\n", source)
				}
				fmt.Fprintf(&engineCases, `"image inspect %s") %s ;;
'image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }} %s') echo %s ;;
"image inspect %s") exit 1 ;;
"tag %s %s") ;;
"image inspect --format {{json .RepoTags}} %s") echo '["%s"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} %s") echo linux/amd64 ;;
"image save --platform linux/amd64 --output "*" %s") printf archive > "$6" ;;
"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images tag %s docker.io/openclaw-development/openshell-%s@%s") ;;
"image rm %s") ;;
`, source, inspect, source, selection["OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION"], staging, source, staging, staging, staging, source, staging, "docker.io/"+staging, component, digest, staging)
				fmt.Fprintf(&inventory, "docker.io/%s application/vnd.oci.image.manifest.v1+json %s\n", staging, digest)
			}
			fmt.Fprintf(&engineCases, `"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images list") printf '%%s' %s ;;`, shellQuote(inventory.String()))
			// No real engine, Helm, or cluster binary is reachable from these fixtures.
			t.Setenv("PATH", t.TempDir())
			commands := fakeProfileCommands(t, map[string]string{
				"docker": engineCases.String(),
				"k3d":    `"image import --mode direct "*" -c occ-dev-owned") ;;`,
				"kubectl": `"get namespace oce-system") ;;
"create secret generic openshell-gateway-jwt-keys "*) ;;
"rollout status deployment/agent-sandbox-controller "*) ;;
"apply -f "*) ;;`,
				"helm": `"show chart "*) ;;
"template openshell-workspace "*) printf 'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: openshell-sandbox\n' ;;
"upgrade --install openshell-gateway "*) ;;`,
			})
			var stdout bytes.Buffer
			r := newRunner(Options{Repository: state.Repository, Out: &stdout})
			r.engine = "docker"
			for key, value := range selection {
				delete(r.env, key)
				if candidate {
					r.env[key] = value
				}
			}
			r.env["OCC_DEVELOPMENT_OPENSHELL_HELM_CHART"] = chart
			r.env["OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART"] = chart
			r.env["OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST"] = manifest
			assets, err := r.prepareOpenShell(context.Background(), state, time.Minute)
			if err != nil {
				t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
			}
			if err := r.installOpenShellGateway(context.Background(), state, assets, "oce-system", time.Minute); err != nil {
				t.Fatal(err)
			}
			var install string
			for _, command := range commands() {
				if strings.HasPrefix(command, "helm upgrade --install openshell-gateway ") {
					install = command
				}
			}
			for _, required := range []string{
				"--namespace oce-system",
				"--set=gateway.image.pullPolicy=Never",
				"--set=sandboxRuntime.image.pullPolicy=Never",
				"--set=supervisor.image.pullPolicy=Never",
				"--set=workspaceResources.enabled=false",
				"--set=server.drivers.kubernetes.allowDriverConfig=true",
				// Harness labels must remain admitted for both image selections.
				openShellAllowedPodLabelsValue,
				"--set=server.drivers.kubernetes.resourceAdmission.enabled=false",
				"--set-string=server.drivers.kubernetes.workspaceMode=operator",
				"--set-string=server.drivers.kubernetes.operatorNamespaceLabel=openshell.ai/openclaw-workspace=true",
				// Only in-cluster OCE components reach the gateway in this profile.
				"--set=service.type=ClusterIP",
			} {
				if !strings.Contains(install, required) {
					t.Fatalf("OpenShell gateway install is missing %q: %s", required, install)
				}
			}
			if strings.Contains(install, "service.type=NodePort") ||
				strings.Contains(install, "supervisor.sandboxRuntime.networkPolicyEnforced=true") {
				t.Fatalf("unexpected OpenShell gateway install values: %s", install)
			}
			// Check every image value: the chart must receive the
			// exact imported digest for each component, never a source digest or fallback.
			args := strings.Fields(install)
			imageArgs := slices.DeleteFunc(args, func(s string) bool {
				return !strings.HasPrefix(s, "--set-string=") || !strings.Contains(s, ".image.")
			})
			var wantArgs []string
			for i, component := range []string{"gateway", "sandbox", "supervisor"} {
				prefix := component
				if component == "sandbox" {
					prefix = "sandboxRuntime"
				}
				digest := "sha256:" + strings.Repeat(string(rune('a'+i)), 64)
				arg := "--set-string=" + prefix + ".image."
				wantArgs = append(wantArgs, arg+"registry=docker.io", arg+"repository=openclaw-development/openshell-"+component, arg+"digest="+digest)
				wantRecord := "OpenShell " + component + " image: source=" + sources[i] + " containerd=docker.io/openclaw-development/openshell-" + component + "@" + digest
				if !strings.Contains(stdout.String(), wantRecord) {
					t.Fatalf("missing import identity: %s", stdout.String())
				}
				if _, err := os.Stat(filepath.Join(state.directory, "openshell", component+"-image.tar")); !os.IsNotExist(err) {
					t.Fatalf("archive remains: %v", err)
				}
				if !slices.Contains(commands(), "docker image rm openclaw-development/openshell-"+component+":"+state.Cluster) {
					t.Fatalf("staging tag not removed: %v", commands())
				}
			}
			slices.Sort(imageArgs)
			slices.Sort(wantArgs)
			if !slices.Equal(imageArgs, wantArgs) {
				t.Fatalf("image arguments = %v, want %v", imageArgs, wantArgs)
			}
		})
	}
}

func TestOpenShellImageImportRegistersThePodmanRecordedName(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	root := t.TempDir()
	source := "ghcr.io/nvidia/openshell/gateway@" + profileTestDigest
	staging := "openclaw-development/openshell-gateway:occ-dev-owned"
	recorded := "localhost/" + staging
	// The first import also loses its stream into the node, so the retry must
	// keep the archive, import it again, and still verify the digest.
	commands := fakeProfileCommands(t, map[string]string{
		"podman": `"image inspect ` + source + `") ;;
"image inspect ` + staging + `") exit 1 ;;
"tag ` + source + ` ` + staging + `") ;;
"image inspect --format {{json .RepoTags}} ` + staging + `") echo '["` + recorded + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + source + `") echo linux/amd64 ;;
"image save --output "*" ` + recorded + `") printf archive > "$4" ;;
"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images list") echo "` + recorded + ` application/vnd.oci.image.manifest.v1+json ` + profileTestDigest + `" ;;
"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images tag ` + recorded + ` localhost/openclaw-development/openshell-gateway@` + profileTestDigest + `") ;;
"image rm ` + staging + `") ;;`,
		"k3d": flakyK3dImportCase(t, state.Cluster, ""),
	})
	var stdout bytes.Buffer
	r := newRunner(Options{Repository: state.Repository, Out: &stdout})
	r.engine = "podman"

	reference, err := r.importOpenShellImage(context.Background(), state, root, "gateway", source, true)
	if err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
	}
	// Podman qualifies the staging tag with `localhost`, and containerd records the
	// imported reference exactly, so the runtime digest alias must use that name.
	if reference != "localhost/openclaw-development/openshell-gateway@"+profileTestDigest {
		t.Fatalf("unexpected runtime reference: %q", reference)
	}
	assertRetriedImport(t, commands(), filepath.Join(root, "gateway-image.tar"), state.Cluster, stdout.String())
}

const controlPlaneKubectlCases = `"-n oce-system get pod bootstrap-password-prepare -o jsonpath={.status.phase}") echo Succeeded ;;
"-n oce-system rollout status statefulset/postgres "*) ;;
"-n oce-system get pod postgres-0 -o jsonpath={.status.podIP}") echo 10.42.0.20 ;;
"-n default get endpoints kubernetes -o jsonpath={.subsets[0].addresses[0].ip}") echo 172.30.42.3 ;;
"-n default get endpoints kubernetes -o jsonpath={.subsets[0].ports[0].port}") echo 6443 ;;
"-n oce-system rollout status deployment/occ-development-api-proxy "*) ;;`

const controlPlaneNetworkCase = `"network inspect k3d-occ-dev-owned") echo '[{"IPAM":{"Config":[{"Subnet":"172.30.42.0/24"}]}}]' ;;`

func TestKubernetesOnlyControlPlaneKeepsPostgreSQLAcrossClusterRestart(t *testing.T) {
	realHelm, helmErr := exec.LookPath("helm")
	state := kubernetesOnlyOpenShellState(t)
	if err := os.WriteFile(filepath.Join(state.directory, "installation.yaml"), []byte("occ: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	commands := fakeProfileCommands(t, map[string]string{
		"kubectl": `"apply -f "*) ;;
` + controlPlaneKubectlCases,
		"docker": controlPlaneNetworkCase,
		"helm":   `"upgrade --install openclaw-enterprise deploy/helm/openclaw-enterprise "*) ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "docker"

	if err := r.installKubernetesControlPlane(context.Background(), state, "controller@"+profileTestDigest, "postgres@"+profileTestDigest, false, time.Minute); err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
	}
	// `k3d cluster stop` and `start` (or a host reboot) delete bare Pods, so a
	// controller must own PostgreSQL for it to come back with its claim.
	postgres := readJSONFile(t, filepath.Join(state.directory, "postgres.json"))
	spec := postgres["spec"].(map[string]any)
	template := spec["template"].(map[string]any)
	if postgres["kind"] != "StatefulSet" || spec["replicas"] != float64(1) ||
		!reflect.DeepEqual(spec["selector"], jsonValue(t, map[string]any{"matchLabels": map[string]string{"app": "postgres"}})) ||
		template["metadata"].(map[string]any)["labels"].(map[string]any)["app"] != "postgres" ||
		!reflect.DeepEqual(template["spec"].(map[string]any)["volumes"].([]any)[0], jsonValue(t, map[string]any{
			"name": "data", "persistentVolumeClaim": map[string]string{"claimName": "postgres-data"},
		})) {
		t.Fatalf("PostgreSQL must be a one-replica StatefulSet on its claim: %#v", postgres)
	}
	if !slices.ContainsFunc(commands(), func(command string) bool {
		return strings.HasPrefix(command, "kubectl -n oce-system rollout status statefulset/postgres ")
	}) {
		t.Fatal("the launcher must wait for the PostgreSQL StatefulSet rollout")
	}
	// The chart admits PostgreSQL and the Kubernetes API only as /32 hosts, and
	// both addresses change on restart. The launcher adds egress that does not.
	values := readJSONFile(t, filepath.Join(state.directory, "helm-values.json"))
	if !reflect.DeepEqual(values["database"], jsonValue(t, map[string]any{"cidrs": []string{"10.42.0.20/32"}})) ||
		!reflect.DeepEqual(values["cluster"], jsonValue(t, map[string]any{"cidrs": []string{"172.30.42.3/32"}, "port": 6443})) {
		t.Fatalf("unexpected chart egress values: %#v %#v", values["database"], values["cluster"])
	}
	restart := readJSONFile(t, filepath.Join(state.directory, "restart-egress.json"))
	policies := map[string]map[string]any{}
	for _, item := range restart["items"].([]any) {
		policy := item.(map[string]any)
		policies[policy["metadata"].(map[string]any)["name"].(string)] = policy["spec"].(map[string]any)
	}
	database := policies["openclaw-development-postgres-egress"]
	cluster := policies["openclaw-development-kubernetes-egress"]
	if database == nil || cluster == nil {
		t.Fatalf("missing restart egress policies: %#v", restart)
	}
	component := func(spec map[string]any) any {
		return spec["podSelector"].(map[string]any)["matchExpressions"].([]any)[0].(map[string]any)["values"]
	}
	if !reflect.DeepEqual(component(database), jsonValue(t, []string{"api", "worker", "initialization"})) ||
		!reflect.DeepEqual(database["egress"], jsonValue(t, []any{map[string]any{
			"to":    []any{map[string]any{"podSelector": map[string]any{"matchLabels": map[string]string{"app": "postgres"}}}},
			"ports": []any{map[string]any{"protocol": "TCP", "port": 5432}},
		}})) {
		t.Fatalf("unexpected PostgreSQL restart egress: %#v", database)
	}
	if !reflect.DeepEqual(component(cluster), jsonValue(t, []string{"api", "worker", "initialization", "collector"})) ||
		!reflect.DeepEqual(cluster["egress"], jsonValue(t, []any{map[string]any{
			"to":    []any{map[string]any{"ipBlock": map[string]any{"cidr": "172.30.42.0/24"}}},
			"ports": []any{map[string]any{"protocol": "TCP", "port": 6443}},
		}})) {
		t.Fatalf("unexpected Kubernetes API restart egress: %#v", cluster)
	}
	// The generated values must still satisfy the chart's own validation.
	if helmErr != nil {
		t.Log("helm is not installed; skipping chart rendering of the generated values")
		return
	}
	assertDevelopmentReplicas(t, renderDevelopmentChart(t, realHelm, state, "openclaw-enterprise",
		"deploy/helm/openclaw-enterprise", "helm-values.json"), 1)
}

func candidateOpenShellEnvironment() map[string]string {
	return map[string]string{
		"OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE":    "registry.example:5000/openshell/gateway@sha256:" + strings.Repeat("1", 64),
		"OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE":    "registry.example/openshell/sandbox@sha256:" + strings.Repeat("2", 64),
		"OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE": "registry.example/openshell/supervisor:candidate@sha256:" + strings.Repeat("3", 64),
		"OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION":  strings.Repeat("a1", 20),
	}
}

func TestOpenShellCandidateSelectionRejectsIncompleteOrInvalidInputs(t *testing.T) {
	keys := []string{"OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE", "OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE", "OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE", "OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION"}
	// Every proper subset must fail, including a revision without images. No
	// omitted component may silently fall back to a released image.
	for mask := 1; mask < 15; mask++ {
		t.Run(fmt.Sprintf("subset-%d", mask), func(t *testing.T) {
			r := &runner{env: candidateOpenShellEnvironment()}
			for i, key := range keys {
				if mask&(1<<i) == 0 {
					delete(r.env, key)
				}
			}
			if _, err := r.selectOpenShellImages("openshell"); err == nil || !strings.Contains(err.Error(), "requires all three") {
				t.Fatalf("partial selection accepted: %v", err)
			}
		})
	}
	for _, test := range []struct{ name, key, value, want string }{
		{"empty image", keys[0], "", "requires all three"},
		{"empty revision", keys[3], "", "requires all three"},
		{"short revision", keys[3], "a1b2c3d", "full 40-character"},
		{"nonhex revision", keys[3], strings.Repeat("g", 40), "full 40-character"},
		{"uppercase revision", keys[3], strings.Repeat("A", 40), "full 40-character"},
		{"mutable tag", keys[0], "registry.example/gateway:latest", "immutable sha256"},
		{"bare digest", keys[1], profileTestDigest, "immutable sha256"},
		{"short digest", keys[2], "registry.example/supervisor@sha256:abc", "immutable sha256"},
		{"nonhex digest", keys[0], "registry.example/gateway@sha256:" + strings.Repeat("z", 64), "immutable sha256"},
		{"wrong algorithm", keys[0], "registry.example/gateway@sha512:" + strings.Repeat("a", 64), "immutable sha256"},
		{"empty name", keys[0], "@" + profileTestDigest, "immutable sha256"},
		{"extra digest", keys[0], "gateway@" + profileTestDigest + "@" + profileTestDigest, "immutable sha256"},
		{"scheme", keys[0], "https://registry.example/gateway@" + profileTestDigest, "immutable sha256"},
		{"empty path component", keys[0], "registry.example//gateway@" + profileTestDigest, "immutable sha256"},
		{"option", keys[0], "--gateway@" + profileTestDigest, "immutable sha256"},
		{"whitespace", keys[0], "registry.example/gateway@" + profileTestDigest + "\n", "immutable sha256"},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := &runner{env: candidateOpenShellEnvironment()}
			r.env[test.key] = test.value
			if _, err := r.selectOpenShellImages("openshell"); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
	r := &runner{env: candidateOpenShellEnvironment()}
	if _, err := r.selectOpenShellImages("none"); err == nil {
		t.Fatal("candidate images ignored without OpenShell")
	}
	// An explicitly empty selector is still a request, not permission to use defaults.
	r.env = map[string]string{keys[0]: ""}
	if _, err := r.selectOpenShellImages("openshell"); err == nil {
		t.Fatal("empty candidate selection accepted")
	}
}

func TestOpenShellCandidateStartupRejectsBeforeResourceEffects(t *testing.T) {
	for _, mode := range []string{"compose", "kubernetes"} {
		for _, component := range []string{"GATEWAY", "SANDBOX", "SUPERVISOR"} {
			for _, failure := range []string{"partial", "malformed", "missing", "wrong revision", "missing label"} {
				t.Run(mode+"/"+component+"/"+failure, func(t *testing.T) {
					root := t.TempDir()
					statePath := filepath.Join(root, "state")
					for _, key := range []string{"DOCKER_CONTEXT", "OCC_DEVELOPMENT_SIGN_IN", "OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE"} {
						t.Setenv(key, "")
					}
					for key, value := range map[string]string{
						"OCC_DEVELOPMENT_STATE_DIRECTORY":     statePath,
						"OCC_DEVELOPMENT_CONTAINER_ENGINE":    "docker",
						"OCC_DEVELOPMENT_CONTROL_PLANE":       mode,
						"OCC_DEVELOPMENT_SANDBOX_DRIVER":      "openshell",
						"OCC_DEVELOPMENT_KUBERNETES_CLUSTER":  "occ-dev-candidate",
						"OPENCLAW_DEV_PORT":                   "3000",
						"OCC_DEVELOPMENT_KUBERNETES_API_PORT": "6443",
						"DOCKER_HOST":                         "unix:///fixture/docker.sock",
					} {
						t.Setenv(key, value)
					}
					selection := candidateOpenShellEnvironment()
					for key, value := range selection {
						t.Setenv(key, value)
					}
					badSource := selection["OCC_DEVELOPMENT_OPENSHELL_"+component+"_IMAGE"]
					want := "revision does not match selected source"
					response := "echo " + strings.Repeat("b", 40)
					switch failure {
					case "partial":
						t.Setenv("OCC_DEVELOPMENT_OPENSHELL_"+component+"_IMAGE", "")
						want = "requires all three"
					case "malformed":
						t.Setenv("OCC_DEVELOPMENT_OPENSHELL_"+component+"_IMAGE", "gateway:latest")
						want = "immutable sha256"
					case "missing":
						response = "exit 1"
						want = "must exist locally"
					case "missing label":
						response = "echo '<no value>'"
					}
					// All external operations are inert subprocess fixtures. Only local
					// engine reads are permitted; any cluster command is a test failure.
					t.Setenv("PATH", t.TempDir())
					commands := fakeProfileCommands(t, map[string]string{
						"docker": `"version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker"}}' ;;
"info"|"compose version") ;;
'image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }} ` + badSource + `') ` + response + ` ;;
'image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }} '*) echo ` + selection["OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION"] + ` ;;`,
						"k3d": "", "kubectl": "", "helm": "",
					})
					err := Up(context.Background(), Options{Repository: root})
					if err == nil || !strings.Contains(err.Error(), want) {
						t.Fatalf("expected %q, got %v", want, err)
					}
					for _, command := range commands() {
						if failure == "partial" || failure == "malformed" || (command != "docker version --format {{json .Server}}" && command != "docker info" && command != "docker compose version" && !strings.HasPrefix(command, "docker image inspect --format ")) {
							t.Fatalf("effect before rejection: %s", command)
						}
					}
					if _, err := os.Stat(statePath); !os.IsNotExist(err) {
						t.Fatalf("startup created state before candidate validation: %v", err)
					}
				})
			}
		}
	}
}

func TestOpenShellImageImportPreservesFailureBoundaries(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	stage := "openclaw-development/openshell-gateway:" + state.Cluster
	list := "echo '" + stage + " application/vnd.oci.image.manifest.v1+json " + profileTestDigest + "'"
	for _, tc := range []struct{ step, reply, want string }{
		{"source", "exit 1", "must still exist locally"},
		{"collision", ":", "staging image already exists"},
		{"platform", "echo windows/amd64", "must contain a Linux platform"},
		{"save", `printf archive > "$6"; exit 42`, "exit status 42"},
		{"import", "exit 42", "k3d failed"},
		{"list", "echo '" + stage + " manifest sha256:invalid'", "could not resolve imported"},
		{"list", list + "; echo 'docker.io/" + stage + " manifest sha256:" + strings.Repeat("b", 64) + "'", "ambiguous imported"},
		{"register", "exit 42", "register imported"},
		{"cleanup", "exit 42", "remove OpenShell gateway staging image"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			root := t.TempDir()
			source := "registry.example/gateway@" + profileTestDigest
			reply := func(step, normal string) string {
				if step == tc.step {
					return tc.reply
				}
				return normal
			}
			t.Setenv("PATH", t.TempDir())
			commands := fakeProfileCommands(t, map[string]string{
				"docker": `"image inspect ` + source + `") ` + reply("source", ":") + ` ;;
"image inspect ` + stage + `") ` + reply("collision", "exit 1") + ` ;;
"tag ` + source + ` ` + stage + `") ;;
"image inspect --format {{json .RepoTags}} ` + stage + `") echo '["` + stage + `"]' ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + source + `") ` + reply("platform", "echo linux/amd64") + ` ;;
"image save --platform linux/amd64 --output "*" ` + stage + `") ` + reply("save", `printf archive > "$6"`) + ` ;;
"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images list") ` + reply("list", list) + ` ;;
"exec k3d-occ-dev-owned-server-0 ctr -n k8s.io images tag ` + stage + ` openclaw-development/openshell-gateway@` + profileTestDigest + `") ` + reply("register", ":") + ` ;;
"image rm ` + stage + `") ` + reply("cleanup", ":") + ` ;;`,
				"k3d": `"image import --mode direct "*" -c occ-dev-owned") ` + reply("import", ":") + ` ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			_, err := r.importOpenShellImage(context.Background(), state, root, "gateway", source, true)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got %v\n%v", tc.want, err, commands())
			}
			calls := commands()
			if tc.step == "source" {
				if !reflect.DeepEqual(calls, []string{"docker image inspect " + source}) {
					t.Fatalf("missing candidate triggered effects: %v", calls)
				}
			} else if tc.step == "collision" {
				if !reflect.DeepEqual(calls, []string{"docker image inspect " + source, "docker image inspect " + stage}) {
					t.Fatalf("collision mutated an existing tag: %v", calls)
				}
			} else {
				if calls[len(calls)-1] != "docker image rm "+stage {
					t.Fatalf("owned staging tag not cleaned: %v", calls)
				}
				if tc.step == "platform" && slices.ContainsFunc(calls, func(call string) bool {
					return strings.HasPrefix(call, "k3d ") || strings.HasPrefix(call, "docker image save ")
				}) {
					t.Fatalf("non-Linux image imported: %v", calls)
				}
			}
			if _, err := os.Stat(filepath.Join(root, "gateway-image.tar")); !os.IsNotExist(err) {
				t.Fatalf("owned archive not cleaned: %v", err)
			}
		})
	}
}

func TestKubernetesOnlyControlPlaneUsesItsPublishedConsoleOrigin(t *testing.T) {
	realHelm, helmErr := exec.LookPath("helm")
	for _, test := range []struct {
		name          string
		sandboxDriver string
		browserPort   int
		origin        string
	}{
		{"OpenShell loopback HTTP", "openshell", 0, "http://127.0.0.1:3100"},
		{"HTTPS without Sandbox", "none", 8444, "https://console.occ-dev-owned.oce.localhost:8444"},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			state.SandboxDriver = test.sandboxDriver
			state.APIPort = 3100
			state.BrowserPort = test.browserPort
			if err := os.WriteFile(filepath.Join(state.directory, "installation.yaml"), []byte("occ: {}\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			commands := fakeProfileCommands(t, map[string]string{
				"kubectl": `"apply -f "*) ;;
"-n oce-system get pod bootstrap-password-prepare -o jsonpath={.status.phase}") echo Succeeded ;;
"-n oce-system rollout status statefulset/postgres "*) ;;
"-n oce-system get pod postgres-0 -o jsonpath={.status.podIP}") echo 10.42.0.20 ;;
"-n default get endpoints kubernetes -o jsonpath={.subsets[0].addresses[0].ip}") echo 172.30.42.3 ;;
"-n default get endpoints kubernetes -o jsonpath={.subsets[0].ports[0].port}") echo 6443 ;;
"-n oce-system rollout status deployment/occ-development-api-proxy "*) ;;`,
				"docker": `"network inspect k3d-occ-dev-owned") echo '[{"IPAM":{"Config":[{"Subnet":"172.30.42.0/24"}]}}]' ;;`,
				"helm":   `"upgrade --install openclaw-enterprise deploy/helm/openclaw-enterprise "*) ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			if err := r.installKubernetesControlPlane(context.Background(), state, "controller@"+profileTestDigest, "postgres@"+profileTestDigest, true, time.Minute); err != nil {
				t.Fatalf("%v\n%s", err, strings.Join(commands(), "\n"))
			}
			values := readJSONFile(t, filepath.Join(state.directory, "helm-values.json"))
			if !reflect.DeepEqual(values["auth"], jsonValue(t, map[string]string{"baseUrl": test.origin})) {
				t.Fatalf("authentication must use the published Console origin: %#v", values["auth"])
			}
			gatewayRouting := map[string]any{"enabled": true, "gatewayClassName": "eg", "apiKeySecretName": "occ-private-gateway-key"}
			if test.sandboxDriver == "openshell" {
				gatewayRouting["hostname"] = developmentGatewayServiceName("oce-system") + ".envoy-gateway-system.svc.cluster.local"
			}
			if !reflect.DeepEqual(values["gatewayRouting"], gatewayRouting) {
				t.Fatalf("private Agent routing must remain enabled: %#v", values["gatewayRouting"])
			}
			gatewayKey := readJSONFile(t, filepath.Join(state.directory, "gateway-api-key.json"))
			key, keyPresent := gatewayKey["stringData"].(map[string]any)["occ"].(string)
			if gatewayKey["metadata"].(map[string]any)["name"] != "occ-private-gateway-key" ||
				!keyPresent || key == "" {
				t.Fatal("private Agent routing must retain its key")
			}
			if test.browserPort == 0 {
				if _, exists := values["agentNativeAdmin"]; exists {
					t.Fatal("OpenShell must not enable native administration")
				}
				for _, name := range []string{"browser-ca.crt", "browser-ca.key", "browser-tls.crt", "browser-tls.key", "browser-tls.json"} {
					if _, err := os.Lstat(filepath.Join(state.directory, name)); !os.IsNotExist(err) {
						t.Fatalf("HTTP-only Console must not create %s: %v", name, err)
					}
				}
			} else {
				if !reflect.DeepEqual(values["agentNativeAdmin"], jsonValue(t, map[string]any{
					"enabled": true, "domain": "agents.occ-dev-owned.oce.localhost", "sharedCookieDomain": "occ-dev-owned.oce.localhost",
				})) {
					t.Fatalf("HTTPS Console must retain native administration: %#v", values["agentNativeAdmin"])
				}
				browserTLS := readJSONFile(t, filepath.Join(state.directory, "browser-tls.json"))
				if browserTLS["metadata"].(map[string]any)["name"] != "occ-development-browser-tls" {
					t.Fatal("HTTPS Console must retain its TLS Secret")
				}
			}
			if helmErr != nil {
				t.Log("helm is not installed; skipping chart rendering of the generated values")
				return
			}
			render := exec.Command(realHelm, "template", "openclaw-enterprise", "deploy/helm/openclaw-enterprise",
				"--namespace", "oce-system", "-f", filepath.Join(state.directory, "helm-values.json"))
			render.Dir = state.Repository
			output, err := render.CombinedOutput()
			if err != nil {
				t.Fatalf("the chart rejected the generated values: %v\n%s", err, output)
			}
			decoder := yaml.NewDecoder(bytes.NewReader(output))
			for {
				var resource map[string]any
				if err := decoder.Decode(&resource); err == io.EOF {
					t.Fatal("rendered API must receive its published Console origin")
				} else if err != nil {
					t.Fatal(err)
				}
				if resource["kind"] != "Deployment" || resource["metadata"].(map[string]any)["name"] != "openclaw-enterprise-api" {
					continue
				}
				pod := resource["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
				for _, container := range pod["containers"].([]any) {
					for _, entry := range container.(map[string]any)["env"].([]any) {
						environment := entry.(map[string]any)
						if environment["name"] == "OCC_AUTH_BASE_URL" && environment["value"] == test.origin {
							return
						}
					}
				}
				t.Fatalf("rendered API must receive Console origin %s", test.origin)
			}
		})
	}
}

func TestKubernetesOnlyPostgresReadinessUsesSelectedDatabaseOverLoopback(t *testing.T) {
	for _, selected := range []string{"", "openclaw_k8s_readiness_2487"} {
		t.Run("database="+selected, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			if err := os.WriteFile(filepath.Join(state.directory, "installation.yaml"), []byte("occ: {}\n"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", t.TempDir())
			commands := fakeProfileCommands(t, map[string]string{
				"kubectl": `"apply -f "*) ;;
` + controlPlaneKubectlCases,
				"docker": controlPlaneNetworkCase,
				"helm":   `"upgrade --install openclaw-enterprise deploy/helm/openclaw-enterprise "*) ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			delete(r.env, "OCC_DEVELOPMENT_DATABASE_NAME")
			want := "openclaw_enterprise"
			if selected != "" {
				r.env["OCC_DEVELOPMENT_DATABASE_NAME"] = selected
				want = selected
			}
			var err error
			state.DatabaseName, err = r.selectedDevelopmentDatabase("kubernetes")
			if err != nil {
				t.Fatal(err)
			}
			// Installation must honor the original selection saved by upK3d.
			r.env["OCC_DEVELOPMENT_DATABASE_NAME"] = "openclaw_k8s_later_selection"
			if err := r.installKubernetesControlPlane(context.Background(), state, "controller@"+profileTestDigest, developmentPostgres, false, time.Minute); err != nil {
				t.Fatalf("%v\n%v", err, commands())
			}
			postgres := readJSONFile(t, filepath.Join(state.directory, "postgres.json"))
			container := postgres["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
			probe := container["readinessProbe"].(map[string]any)
			if !reflect.DeepEqual(probe, jsonValue(t, map[string]any{
				"exec":                map[string]any{"command": []string{"pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", want}},
				"initialDelaySeconds": 2, "periodSeconds": 2,
			})) {
				t.Fatalf("readiness must use loopback TCP and the original database: %#v", probe)
			}
			if !reflect.DeepEqual(container["env"].([]any)[0], jsonValue(t, map[string]string{"name": "POSTGRES_DB", "value": want})) {
				t.Fatal("PostgreSQL database differs from readiness database")
			}
			bootstrap := readJSONFile(t, filepath.Join(state.directory, "postgres-bootstrap.json"))
			if !strings.Contains(bootstrap["stringData"].(map[string]any)["init.sql"].(string), "GRANT CREATE ON DATABASE "+want+" TO occ_migrator;") {
				t.Fatal("bootstrap SQL uses a different database")
			}
			secrets := readJSONFile(t, filepath.Join(state.directory, "oce-secrets.json"))
			database := secrets["items"].([]any)[1].(map[string]any)["stringData"].(map[string]any)
			for _, key := range []string{"application-url", "migration-url"} {
				if !strings.HasSuffix(database[key].(string), "@postgres.oce-system.svc.cluster.local:5432/"+want) {
					t.Fatalf("%s uses a different database", key)
				}
			}
		})
	}
}
