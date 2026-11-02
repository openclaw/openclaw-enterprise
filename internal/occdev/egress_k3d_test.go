package occdev

import (
	"bytes"
	"cmp"
	"context"
	"crypto/x509"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

func TestProtectedEgressSelectionFailsBeforeEffects(t *testing.T) {
	env := candidateOpenShellEnvironment()
	env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = "1"
	for _, key := range []string{"OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE"} {
		env[key] = "registry.example/runtime@" + profileTestDigest
	}
	for _, key := range []string{"OCC_DEVELOPMENT_OPENSHELL_HELM_CHART", "OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART"} {
		env[key] = "/explicit/chart"
	}
	r := &runner{env: env}
	check := func(controlPlane, sandbox, want string) {
		t.Helper()
		enabled, err := r.protectedEgressSelection(controlPlane, sandbox)
		if enabled != (want == "enabled") || (err != nil) != (want == "rejected") {
			t.Fatalf("selection for %s/%s, env=%v: enabled=%t, err=%v, want %s", controlPlane, sandbox, r.env, enabled, err, want)
		}
	}
	check("kubernetes", "openshell", "enabled")
	original := r.env
	r.env = map[string]string{"OCC_DEVELOPMENT_PROTECTED_EGRESS": "1"}
	check("kubernetes", "openshell", "enabled")
	r.env = original
	check("compose", "openshell", "rejected")
	check("kubernetes", "none", "rejected")
	for key, value := range env {
		if key == "OCC_DEVELOPMENT_PROTECTED_EGRESS" {
			continue
		}
		delete(env, key)
		check("kubernetes", "openshell", "enabled")
		env[key] = value
	}
	// Only an explicitly selected owned private host can receive the native alias.
	for _, address := range []string{"", "127.0.0.1", "0.0.0.0", "169.254.169.254", "8.8.8.8", "::1", "172.030.42.1", "host.example.test"} {
		env["OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"] = address
		check("kubernetes", "openshell", "rejected")
	}
	env["OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"] = "172.30.42.1"
	check("kubernetes", "openshell", "enabled")
	env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = "0"
	check("kubernetes", "openshell", "rejected")
	delete(env, "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP")
	for _, value := range []string{"true", "yes", "2"} {
		env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = value
		check("kubernetes", "openshell", "rejected")
	}
	for _, value := range []string{"", "0"} {
		r.env = map[string]string{"OCC_DEVELOPMENT_PROTECTED_EGRESS": value}
		check("compose", "none", "disabled")
	}
}

func TestDevelopmentDatabaseSelectorIsDisposable(t *testing.T) {
	r := &runner{env: map[string]string{}}
	if name, err := r.selectedDevelopmentDatabase("compose"); err != nil || name != "openclaw_enterprise" {
		t.Fatalf("default changed: %s %v", name, err)
	}
	for _, name := range []string{"", "production", "openclaw_enterprise", "openclaw_k8s_", "openclaw_k8s_Foo", "openclaw_k8s_x;DROP DATABASE x", "openclaw_k8s_" + strings.Repeat("a", 51)} {
		r.env["OCC_DEVELOPMENT_DATABASE_NAME"] = name
		if _, err := r.selectedDevelopmentDatabase("kubernetes"); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	r.env["OCC_DEVELOPMENT_DATABASE_NAME"] = "openclaw_k8s_connected"
	if _, err := r.selectedDevelopmentDatabase("compose"); err == nil {
		t.Fatal("Compose accepted an unsupported database selector")
	}
	if name, err := r.selectedDevelopmentDatabase("kubernetes"); err != nil || name != "openclaw_k8s_connected" {
		t.Fatalf("valid database refused: %v", err)
	}
}

// Run the normal release coordinator with command-boundary fixtures. The ordering,
// readiness-gate, PKI, TLS and database assertions always run. When the tools are
// present, the resulting Installation is also loaded by real controller
// composition (Node) and the OCE chart is rendered by real Helm. Selecting a
// supplier chart with OCC_TEST_OPENSHELL_CHART requires both tools and renders
// both charts. This proves packaging/order, not Kubernetes or PostgreSQL.
func TestProtectedPlatformInstallationOrdersAuthorityBeforeGatewayReadiness(t *testing.T) {
	t.Run("gateway ready", func(t *testing.T) { testProtectedPlatformInstallation(t, "0") })
	t.Run("gateway rollout fails", func(t *testing.T) { testProtectedPlatformInstallation(t, "42") })
}

func testProtectedPlatformInstallation(t *testing.T, rolloutExit string) {
	// Resolve the real tools before PATH is replaced by the command fixtures.
	supplierChart := os.Getenv("OCC_TEST_OPENSHELL_CHART")
	gatewayChart := cmp.Or(supplierChart, "/supplier/openshell-gateway")
	realNode, nodeErr := exec.LookPath("node")
	helm, helmErr := exec.LookPath(cmp.Or(os.Getenv("OCC_HELM_BIN"), "helm"))
	if supplierChart != "" && (nodeErr != nil || helmErr != nil) {
		t.Fatalf("OCC_TEST_OPENSHELL_CHART requires Node and Helm: node=%v, helm=%v", nodeErr, helmErr)
	}
	state := kubernetesOnlyOpenShellState(t)
	state.ProtectedEgress = true
	state.DatabaseName = "openclaw_k8s_connected"
	state.OpenShellHostGatewayIP = "172.30.42.1"
	// At each OCE release boundary, render the actual Helm arguments, dropping
	// only cluster-operation flags. Save the initial values to catch persisting
	// a temporary zero or changing the steady-state inputs at worker activation.
	render := ":"
	if helmErr == nil {
		t.Setenv("RELEASE_DIR", state.directory)
		render = `
revision=install
upgrade=
case " $* " in
  *" --install "*) /bin/cp "$RELEASE_DIR/helm-values.json" "$RELEASE_DIR/install-values" || exit 1 ;;
  *) revision=upgrade; upgrade=--is-upgrade
     /usr/bin/cmp "$RELEASE_DIR/install-values" "$RELEASE_DIR/helm-values.json" || exit 1 ;;
esac
shift # upgrade
skip=
for arg do
  shift
  if [ -n "$skip" ]; then skip=; continue; fi
  case "$arg" in
    --install|--wait) ;;
    --timeout|--kubeconfig|--kube-context) skip=1 ;;
    *) set -- "$@" "$arg" ;;
  esac
done
` + shellQuote(helm) + ` template "$@" $upgrade --show-only templates/deployments.yaml > "$RELEASE_DIR/$revision.yaml"`
	}
	assets := &openShellDevelopmentAssets{gatewayChart: gatewayChart, gatewayImage: "registry.example/gateway@" + profileTestDigest,
		sandboxImage: "registry.example/sandbox@" + profileTestDigest, supervisorImage: "registry.example/supervisor@" + profileTestDigest,
		workspaceResources: []any{map[string]any{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]string{"name": "openshell-sandbox"}}}}
	// No actual engine or cluster command is reachable from the command fixtures.
	t.Setenv("PATH", t.TempDir())
	commands := fakeProfileCommands(t, map[string]string{
		"kubectl": `"get namespace oce-system") ;;
"apply -f "*) ;;
"get secret openshell-gateway-jwt-keys --namespace oce-system -o jsonpath={.data.kid}") echo dGVzdC1raWQ= ;;
"get node k3d-occ-dev-owned-server-0 -o json") echo '{"spec":{"podCIDR":"10.42.0.0/24"}}' ;;
"get service openshell-gateway --namespace oce-system -o jsonpath={.spec.clusterIP}") echo 10.43.0.50 ;;
` + controlPlaneKubectlCases + `
"rollout status statefulset/openshell-gateway --namespace oce-system --timeout 1m0s") exit ` + rolloutExit + ` ;;`,
		"docker": `"exec k3d-occ-dev-owned-server-0 ip route get 10.42.0.2") echo '10.42.0.2 dev cni0 src 10.42.0.1' ;;
` + controlPlaneNetworkCase,
		"helm": `"upgrade --install openshell-gateway "*) ;;
"upgrade "*"openclaw-enterprise deploy/helm/openclaw-enterprise "*) ` + render + ` ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "docker"
	err := r.installDevelopmentPlatform(context.Background(), state, developmentPlatformInputs{
		openShell: assets, runtimeImage: "registry.example/runtime@" + profileTestDigest,
		controllerImage: "registry.example/controller@" + profileTestDigest, postgresImage: "registry.example/postgres@" + profileTestDigest,
	}, time.Minute)
	if rolloutExit != "0" {
		if err == nil || !strings.Contains(err.Error(), "OpenShell Gateway rollout") || !strings.Contains(err.Error(), "exit status "+rolloutExit) {
			t.Errorf("expected protected Gateway rollout failure with exit %s, got %v", rolloutExit, err)
		}
	} else if err != nil {
		t.Fatalf("platform packaging failed: %v\n%s", err, strings.Join(commands(), "\n"))
	}
	log := commands()
	find := func(operation string) int {
		i := slices.IndexFunc(log, func(s string) bool { return strings.Contains(s, operation) })
		if i < 0 {
			t.Fatalf("missing operation %s", operation)
		}
		return i
	}
	authority := find("kubectl apply -f " + filepath.Join(state.directory, "egress-tls.json"))
	gateway := find("helm upgrade --install openshell-gateway ")
	kid := find("kubectl get secret openshell-gateway-jwt-keys ")
	control := find("openclaw-enterprise deploy/helm/openclaw-enterprise ")
	ready := find("kubectl rollout status statefulset/openshell-gateway ")
	access := find("kubectl apply -f " + filepath.Join(state.directory, "development-tenant-access.json"))
	network := find("kubectl apply -f " + filepath.Join(state.directory, "openshell-network-policies.json"))
	if !(authority < gateway && gateway < kid && kid < control && control < access && access < network && network < ready) {
		t.Fatal("expected TLS, Gateway, key ID, OCE release, tenant access, policies, then Gateway readiness")
	}
	checkWorkerAccess(t, state.directory, state.PlatformNamespace)
	if helmErr == nil {
		assertDevelopmentReleaseReplicas(t, state.directory, "install.yaml", 0)
	}
	if strings.Contains(log[gateway], "--wait") || !strings.Contains(log[control], "--wait") {
		t.Fatal("incorrect release readiness gates")
	}
	if strings.Contains(strings.Join(log, "\n"), "create secret generic openshell-gateway-jwt-keys") {
		t.Fatal("protected mode must leave complete PKI generation to OpenShell")
	}
	// The fixture rejects direct scaling or unexpected commands. Check the full
	// OCE release history so a later zero cannot conceal an early worker request.
	releases := slices.DeleteFunc(slices.Clone(log), func(s string) bool {
		return !(strings.HasPrefix(s, "helm ") && strings.Contains(s, " openclaw-enterprise "))
	})
	const initialWorker = "--install --set worker.replicaCount=0"
	initial := log[control]
	if !strings.Contains(initial, initialWorker) || strings.Contains(initial, "--no-hooks") {
		t.Errorf("first OCE release must keep hooks and request no workers: %s", initial)
	}
	if rolloutExit != "0" {
		if ready != len(log)-1 || len(releases) != 1 {
			t.Fatalf("failed Gateway rollout must stop after the first OCE release; commands:\n%s", strings.Join(log, "\n"))
		}
		return
	}
	want := strings.Replace(initial, initialWorker, "--set worker.replicaCount=1", 1)
	if !slices.Equal(log[ready+1:], []string{want}) || len(releases) != 2 {
		t.Fatalf("expected one OCE upgrade activating the worker after Gateway rollout; commands:\n%s", strings.Join(log, "\n"))
	}
	if helmErr == nil {
		assertDevelopmentReleaseReplicas(t, state.directory, "upgrade.yaml", 1)
	}

	// Use the actual startup parser/Driver composition, without provider or cluster I/O.
	if nodeErr != nil {
		t.Log("node not found; skipping the real startup parse of the generated Installation")
	} else {
		parseGeneratedInstallation(t, realNode, state)
	}

	// The generated server leaf must authenticate the authority service hostname.
	caPEM, _ := os.ReadFile(filepath.Join(state.directory, "egress-ca.crt"))
	leafPEM, _ := os.ReadFile(filepath.Join(state.directory, "egress-tls.crt"))
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		t.Fatal("authority CA is invalid")
	}
	leaf := parseDevelopmentCertificate(t, leafPEM)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "openclaw-enterprise-egress-authority.oce-system.svc.cluster.local"}); err != nil {
		t.Fatal(err)
	}

	// Creation, readiness, migration and application URLs select one disposable database.
	postgres := readJSONFile(t, filepath.Join(state.directory, "postgres.json"))
	container := field(t, postgres, "spec", "template", "spec", "containers", 0)
	if field(t, container, "env", 0, "value") != state.DatabaseName {
		t.Fatal("database creation selector diverged")
	}
	probe := field(t, container, "readinessProbe", "exec", "command").([]any)
	if probe[len(probe)-1] != state.DatabaseName {
		t.Fatal("database readiness selector diverged")
	}
	secrets := readJSONFile(t, filepath.Join(state.directory, "oce-secrets.json"))["items"].([]any)
	urls := secrets[1].(map[string]any)["stringData"].(map[string]any)
	for key, role := range map[string]string{"application-url": "occ_app", "migration-url": "occ_migrator"} {
		u, err := url.Parse(urls[key].(string))
		if err != nil || u.Path != "/openclaw_k8s_connected" || u.User.Username() != role {
			t.Fatalf("database role or selector diverged for %s", key)
		}
	}
	selectedGateway := readJSONFile(t, filepath.Join(state.directory, "openshell-protected-values.json"))
	if selectedGateway["server"].(map[string]any)["hostGatewayIP"] != state.OpenShellHostGatewayIP {
		t.Fatal("selected owned host did not reach the supplier chart input")
	}
	if helmErr != nil {
		t.Log("helm not found (set OCC_HELM_BIN); skipping chart renders")
		return
	}
	// Later OCE upgrades use the saved values without a replica override.
	assertDevelopmentReplicas(t, renderDevelopmentChart(t, helm, state, "openclaw-enterprise",
		"deploy/helm/openclaw-enterprise", "install-values"), 1)
	if supplierChart != "" {
		out := renderDevelopmentChart(t, helm, state, openShellGatewayService, supplierChart,
			"openshell-protected-values.json", "--set", "agentSandbox.preflight.enabled=false", "--set", "fullnameOverride=openshell-gateway")
		if err := verifyProtectedOpenShellChart(out, state); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Log("OCC_TEST_OPENSHELL_CHART unset; skipping the supplier chart render")
	}
}

func renderDevelopmentChart(t *testing.T, helm string, state *developmentState, release, chart, values string, extra ...string) []byte {
	t.Helper()
	args := []string{"template", release, chart, "--namespace", state.PlatformNamespace, "-f", filepath.Join(state.directory, values)}
	cmd := exec.Command(helm, append(args, extra...)...)
	cmd.Dir = state.Repository
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s chart rejected launch values: %v\n%s", release, err, out)
	}
	return out
}

func assertDevelopmentReleaseReplicas(t *testing.T, dir, name string, workers int) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	assertDevelopmentReplicas(t, data, workers)
}

func assertDevelopmentReplicas(t *testing.T, manifest []byte, workers int) {
	t.Helper()
	var deployments []any
	decoder := yaml.NewDecoder(bytes.NewReader(manifest))
	for {
		var obj map[string]any
		if err := decoder.Decode(&obj); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if obj["kind"] == "Deployment" {
			deployments = append(deployments, obj)
		}
	}
	for component, replicas := range map[string]int{"api": 1, "worker": workers} {
		name := "openclaw-enterprise-" + component
		obj := manifestByKind(t, deployments, "Deployment", name)
		if n := field(t, obj, "spec", "replicas"); n != float64(replicas) {
			t.Errorf("%s Deployment requests %v replicas; want %d", name, n, replicas)
		}
	}
}

func checkWorkerAccess(t *testing.T, dir, namespace string) {
	t.Helper()
	const workspaceRole = "openclaw-development-openshell-workspace-rbac"
	bindings := map[string]string{"openclaw-development-tenant-worker": "openclaw-enterprise-openclaw-tenant-worker", workspaceRole: workspaceRole}
	access := readJSONFile(t, filepath.Join(dir, "development-tenant-access.json"))
	for name, role := range bindings {
		binding := manifestByKind(t, access["items"].([]any), "ClusterRoleBinding", name)
		subject := field(t, binding, "subjects", 0).(map[string]any)
		if subject["kind"] != "ServiceAccount" || subject["name"] != "openclaw-enterprise-worker" ||
			subject["namespace"] != namespace || field(t, binding, "roleRef", "name") != role {
			t.Fatalf("%s must grant %s to the development worker account", name, role)
		}
	}
	policies := readJSONFile(t, filepath.Join(dir, "openshell-network-policies.json"))["items"].([]any)
	for _, name := range []string{"openclaw-enterprise-openshell-egress", "openclaw-development-openshell-ingress"} {
		policy := manifestByKind(t, policies, "NetworkPolicy", name)
		if field(t, policy, "metadata", "namespace") != namespace {
			t.Fatalf("expected %s policy in %s", name, namespace)
		}
	}
}

func parseGeneratedInstallation(t *testing.T, realNode string, state *developmentState) {
	t.Helper()
	program := `import assert from 'node:assert/strict';
import { loadInstallationConfiguration, loadStartupConfigurationSnapshot } from './apps/controller/src/composition/installation-config.ts';
const options = { mode: 'production', environment: { OCC_CONFIG_PATH: process.argv[1] } };
const startupConfiguration = await loadStartupConfigurationSnapshot(options);
// Check the Gateway identity in the generated input. Composition keeps the authority inside the Driver.
const { keyId, issuer } = startupConfiguration.configuration.drivers.credential_proxy.configuration.authority;
assert.equal(keyId, 'test-kid');
assert.equal(issuer, 'openshell-gateway:openshell-gateway');

const { installation, protectedDriver, sandboxDriver, proxyDriver } =
  await loadInstallationConfiguration({ ...options, startupConfiguration });
const backend = installation.backend[0];
assert.equal(backend.configuration.auth.mode, 'mtls');
assert.equal(backend.drivers.credential_proxy, proxyDriver.id);
assert.ok(protectedDriver.require('sandbox') === sandboxDriver, 'expected the installed Sandbox');
assert.ok(protectedDriver.require('credential_proxy') === proxyDriver, 'expected the installed Credential Proxy');
assert.equal(typeof proxyDriver.bindExchange, 'function');
`
	parse := exec.Command(realNode, "--input-type=module", "-e", program, filepath.Join(state.directory, "installation.yaml"))
	parse.Dir = state.Repository
	if out, err := parse.CombinedOutput(); err != nil {
		t.Fatalf("generated Installation contract failed: %v\n%s", err, out)
	}
}
