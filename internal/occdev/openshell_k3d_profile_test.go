package occdev

import (
	"bytes"
	"context"
	"encoding/json"
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

const profileTestDigest = "sha256:17b2f65d1e33f32a419ecc98dd42389b0227280be54139c14834933ec29420ea"

// fakeProfileCommands puts fake binaries on PATH. Each records its arguments and
// answers only the listed cases, so a step that issues a new command fails.
func fakeProfileCommands(t *testing.T, scripts map[string]string) func() []string {
	t.Helper()
	directory := t.TempDir()
	log := filepath.Join(directory, "commands.log")
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
			CredentialGateway struct {
				Configuration struct {
					Binaries []string `yaml:"binaries"`
				} `yaml:"configuration"`
			} `yaml:"credential_gateway"`
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
	// Native OpenClaw inference is a Node child; Codex still needs its exact
	// executable. The rendered profile must grant both, never an empty allowlist.
	if !reflect.DeepEqual(installation.Drivers.CredentialGateway.Configuration.Binaries, []string{
		openShellCodexBinary,
		"/usr/local/bin/node",
	}) {
		t.Fatalf("unexpected model-credential binaries: %v", installation.Drivers.CredentialGateway.Configuration.Binaries)
	}
	sandbox := installation.Drivers.Sandbox.Configuration
	if sandbox.StartupDelayMs != 30_000 {
		t.Fatalf("unexpected OpenShell startup delay: %d", sandbox.StartupDelayMs)
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
	state := kubernetesOnlyOpenShellState(t)
	if err := os.Mkdir(filepath.Join(state.directory, "openshell"), 0o700); err != nil {
		t.Fatal(err)
	}
	commands := fakeProfileCommands(t, map[string]string{
		"kubectl": `"get namespace oce-system") ;;
"create secret generic openshell-gateway-jwt-keys "*) ;;
"apply -f "*) ;;`,
		"helm": `"upgrade --install openshell-gateway "*) ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	assets := &openShellDevelopmentAssets{
		gatewayChart:    "/charts/openshell",
		gatewayImage:    "docker.io/openclaw-development/openshell-gateway@" + profileTestDigest,
		sandboxImage:    "docker.io/openclaw-development/openshell-sandbox@" + profileTestDigest,
		supervisorImage: "docker.io/openclaw-development/openshell-supervisor@" + profileTestDigest,
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
		"--set-string=gateway.image.registry=docker.io",
		"--set-string=gateway.image.repository=openclaw-development/openshell-gateway",
		"--set-string=gateway.image.digest=" + profileTestDigest,
		"--set=workspaceResources.enabled=false",
		"--set=server.drivers.kubernetes.allowDriverConfig=true",
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

	reference, err := r.importOpenShellImage(context.Background(), state, root, "gateway", source)
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

func TestKubernetesOnlyControlPlaneKeepsPostgreSQLAcrossClusterRestart(t *testing.T) {
	realHelm, helmErr := exec.LookPath("helm")
	state := kubernetesOnlyOpenShellState(t)
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
	render := exec.Command(realHelm, "template", "openclaw-enterprise", "deploy/helm/openclaw-enterprise",
		"--namespace", "oce-system", "-f", filepath.Join(state.directory, "helm-values.json"))
	render.Dir = state.Repository
	if output, err := render.CombinedOutput(); err != nil {
		t.Fatalf("the chart rejected the generated values: %v\n%s", err, output)
	}
}
