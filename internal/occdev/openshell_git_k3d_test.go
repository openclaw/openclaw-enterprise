package occdev

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json/v2"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

func openShellGitEnvironment(t *testing.T) map[string]string {
	t.Helper()
	return map[string]string{
		openShellGitSelector:                         "1",
		"OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY": "/private/repository-inputs",
	}
}

func writeTestCA(t *testing.T) string {
	t.Helper()
	files, _, err := generateDevelopmentTLS("fixture", "fixture CA", []string{"github.com", "api.github.com"})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fixture-ca.crt")
	if err := os.WriteFile(path, files["fixture-ca.crt"], 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOpenShellGitSelectionFailsBeforeEffects(t *testing.T) {
	env := openShellGitEnvironment(t)
	r := &runner{env: env}
	check := func(controlPlane, sandbox string, protected bool, want string) {
		t.Helper()
		enabled, err := r.openShellGitSelection(controlPlane, sandbox, protected)
		if enabled != (want == "enabled") || (err != nil) != (want == "rejected") {
			t.Fatalf("selection for %s/%s protected=%t env=%v: enabled=%t err=%v, want %s", controlPlane, sandbox, protected, env, enabled, err, want)
		}
	}
	check("kubernetes", "openshell", false, "enabled")
	check("compose", "openshell", false, "rejected")
	check("kubernetes", "none", false, "rejected")
	// The OCE chart refuses openshellGit with egressAuthority; refuse it before any effect.
	check("kubernetes", "openshell", true, "rejected")
	delete(env, "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY")
	check("kubernetes", "openshell", false, "rejected")
	env["OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY"] = "/private/repository-inputs"
	// The Compute-owned private origin cannot stand in for github.com.
	env["OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN"] = "https://172.17.0.1:8443"
	check("kubernetes", "openshell", false, "rejected")
	delete(env, "OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN")
	for _, network := range []string{"-bad", "a b", "x;y"} {
		env[openShellGitFixtureNetworkSelector] = network
		check("kubernetes", "openshell", false, "rejected")
	}
	env[openShellGitFixtureNetworkSelector] = "occ-fixture"
	check("kubernetes", "openshell", false, "enabled")

	ca := writeTestCA(t)
	notCA := filepath.Join(t.TempDir(), "key.pem")
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	if err := os.WriteFile(notCA, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"relative.crt", ca + "/../fixture-ca.crt", filepath.Join(t.TempDir(), "missing.crt"), notCA} {
		env[openShellSupervisorCASelector] = path
		check("kubernetes", "openshell", false, "rejected")
	}
	env[openShellSupervisorCASelector] = ca
	check("kubernetes", "openshell", false, "enabled")

	// Its inputs need the route itself.
	for _, value := range []string{"", "0"} {
		env[openShellGitSelector] = value
		check("kubernetes", "openshell", false, "rejected")
		delete(env, openShellSupervisorCASelector)
		check("kubernetes", "openshell", false, "rejected")
		delete(env, openShellGitFixtureNetworkSelector)
		check("kubernetes", "openshell", false, "disabled")
		env[openShellGitFixtureNetworkSelector] = "occ-fixture"
		env[openShellSupervisorCASelector] = ca
	}
	for _, value := range []string{"true", "yes", "2"} {
		env[openShellGitSelector] = value
		check("kubernetes", "openshell", false, "rejected")
	}
}

func TestOpenShellGitPoliciesLeaveGitHubToTheRoute(t *testing.T) {
	fetch := map[string]any{"name": "example-fetch", "endpoints": []any{map[string]any{"host": "example.com", "ports": []any{443}}}}
	if err := checkOpenShellGitPolicies(nil); err == nil || !strings.Contains(err.Error(), "--sandbox-network-policy-file") {
		t.Fatalf("the Driver needs a policy once source-control is withdrawn: %v", err)
	}
	if err := checkOpenShellGitPolicies([]any{fetch}); err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"github.com", "API.GitHub.com", "github.com."} {
		overlap := map[string]any{"name": "extra-git", "endpoints": []any{map[string]any{"host": host, "ports": []any{443}}}}
		if err := checkOpenShellGitPolicies([]any{fetch, overlap}); err == nil || !strings.Contains(err.Error(), `"extra-git"`) {
			t.Fatalf("%s overlap was not named: %v", host, err)
		}
	}
	state := &developmentState{OpenShellGit: true, SandboxNetworkPolicies: []any{fetch}}
	if got := openShellSandboxNetworkPolicies(state); len(got) != 1 || sandboxPoliciesReachGitHub(got) != "" {
		t.Fatalf("the route must withdraw source-control: %v", got)
	}
	state.OpenShellGit = false
	if sandboxPoliciesReachGitHub(openShellSandboxNetworkPolicies(state)) != "source-control" {
		t.Fatal("the ordinary profile lost its source-control policy")
	}
}

func TestOpenShellGitKernelPrerequisite(t *testing.T) {
	for release, want := range map[string]bool{
		"6.2.0": true, "6.8.0-138-generic": true, "7.2.8-arch1-2": true, "6.10.1": true,
		"6.1.55": false, "5.15.0-198-generic": false, "5.19": false, "": false, "garbage": false, "6": false,
	} {
		if got := kernelAtLeast(release, 6, 2); got != want {
			t.Errorf("kernelAtLeast(%q) = %t, want %t", release, got, want)
		}
	}
	directory := t.TempDir()
	release, lsm := filepath.Join(directory, "osrelease"), filepath.Join(directory, "lsm")
	hostKernelReleasePath, hostLSMPath = release, lsm
	t.Cleanup(func() { hostKernelReleasePath, hostLSMPath = "/proc/sys/kernel/osrelease", "/sys/kernel/security/lsm" })
	run := func(engine, kernel, host, active string) error {
		t.Helper()
		t.Setenv("PATH", t.TempDir())
		fakeProfileCommands(t, map[string]string{
			"docker": `"info --format {{.KernelVersion}}") echo ` + kernel + ` ;;`,
			"podman": `"info --format {{.Host.Kernel}}") echo ` + kernel + ` ;;`,
		})
		os.Remove(release)
		os.Remove(lsm)
		if host != "" {
			os.WriteFile(release, []byte(host+"\n"), 0600)
		}
		if active != "" {
			os.WriteFile(lsm, []byte(active), 0600)
		}
		r := newRunner(Options{})
		r.engine = engine
		return r.checkOpenShellGitKernel(context.Background())
	}
	if err := run("docker", "5.15.0-198-generic", "", ""); err == nil || !strings.Contains(err.Error(), "Linux 6.2") || !strings.Contains(err.Error(), "5.15.0-198-generic") {
		t.Fatalf("an old engine kernel must fail early with its version: %v", err)
	}
	if err := run("podman", "6.1.0", "", ""); err == nil {
		t.Fatal("Podman's kernel was not checked")
	}
	// A local engine shares this host's kernel and LSM list.
	if err := run("docker", "6.8.0-138-generic", "6.8.0-138-generic", "lockdown,capability,yama,apparmor"); err == nil || !strings.Contains(err.Error(), "Landlock LSM") {
		t.Fatalf("a local kernel without Landlock must fail early: %v", err)
	}
	for _, tt := range []struct{ host, active string }{
		{"6.8.0-138-generic", "lockdown,capability,landlock,yama,apparmor"},
		{"6.8.0-138-generic", ""},       // unreadable LSM list: Sandbox startup decides
		{"7.2.8-arch1-2", "capability"}, // a remote engine's kernel is not this host's
	} {
		if err := run("docker", "6.8.0-138-generic", tt.host, tt.active); err != nil {
			t.Fatalf("host %s lsm %q: %v", tt.host, tt.active, err)
		}
	}
}

func TestOpenShellGitFixtureAddressMustBeReachableFromSandboxes(t *testing.T) {
	for _, address := range []string{"10.0.0.2", "172.17.0.2", "192.168.1.2", "127.0.0.1", "169.254.1.1", "100.64.0.1", "192.0.2.10", "198.18.0.1", "198.51.100.2", "203.0.113.9", "0.0.0.1", "224.0.0.1", "240.0.0.1", "192.0.0.8"} {
		if !openShellBlocksAddress(netip.MustParseAddr(address)) {
			t.Errorf("%s should be refused like OpenShell's SSRF guard", address)
		}
		if _, err := openShellGitFixtureAddress([]string{address + "/32"}); err == nil {
			t.Errorf("fixture address %s accepted", address)
		}
	}
	if got, err := openShellGitFixtureAddress([]string{"11.112.0.10/32"}); err != nil || got.String() != "11.112.0.10" {
		t.Fatalf("public-range fixture refused: %v", err)
	}
	if _, err := openShellGitFixtureAddress([]string{"11.112.0.10/32", "11.112.0.11/32"}); err == nil {
		t.Fatal("a fixture network needs exactly one upstream address")
	}
	api := filepath.Join(t.TempDir(), "api-version")
	fakeProfileCommands(t, map[string]string{
		"docker": `"network inspect occ-fixture") echo '[{"IPAM":{"Config":[{"Subnet":"11.112.0.8/29"}]}}]' ;;
"version --format {{.Server.APIVersion}}") cat ` + shellQuote(api) + ` ;;`,
	})
	if err := os.WriteFile(api, []byte("1.48\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ca := writeTestCA(t)
	caPEM, err := os.ReadFile(ca)
	if err != nil {
		t.Fatal(err)
	}
	fixture := func(cidr string) *developmentRepositoryInputs {
		return &developmentRepositoryInputs{upstreamCIDRs: []string{cidr}, issuerCA: caPEM}
	}
	r := newRunner(Options{})
	r.engine = "docker"
	r.env[openShellGitFixtureNetworkSelector] = "occ-fixture"
	r.env[openShellSupervisorCASelector] = ca
	if err := r.checkOpenShellGitFixture(context.Background(), fixture("11.112.0.10/32")); err != nil {
		t.Fatal(err)
	}
	if err := r.checkOpenShellGitFixture(context.Background(), fixture("11.112.0.18/32")); err == nil || !strings.Contains(err.Error(), "does not contain") {
		t.Fatalf("an address outside the fixture network was accepted: %v", err)
	}
	// The worker and the supervisor must both trust the synthetic origin's CA.
	if err := r.checkOpenShellGitFixture(context.Background(), &developmentRepositoryInputs{upstreamCIDRs: []string{"11.112.0.10/32"}}); err == nil || !strings.Contains(err.Error(), "issuer-ca.crt") {
		t.Fatalf("a fixture without its issuer CA was accepted: %v", err)
	}
	delete(r.env, openShellSupervisorCASelector)
	if err := r.checkOpenShellGitFixture(context.Background(), fixture("11.112.0.10/32")); err == nil || !strings.Contains(err.Error(), openShellSupervisorCASelector) {
		t.Fatalf("a fixture without supervisor trust was accepted: %v", err)
	}
	r.env[openShellSupervisorCASelector] = ca
	// Gateway priority on network connect needs Docker Engine 28 (API 1.48).
	if err := os.WriteFile(api, []byte("1.47\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.checkOpenShellGitFixture(context.Background(), fixture("11.112.0.10/32")); err == nil || !strings.Contains(err.Error(), "Docker Engine 28") {
		t.Fatalf("an engine without gateway priority was accepted: %v", err)
	}
	for version, want := range map[string]bool{"1.48": true, "1.52": true, "2.0": true, "1.47": false, "1": false, "x.y": false, "": false} {
		if got := dockerAPIAtLeast(version, 1, 48); got != want {
			t.Errorf("dockerAPIAtLeast(%q) = %v", version, got)
		}
	}
	r.engine = "podman"
	if err := r.checkOpenShellGitFixture(context.Background(), fixture("11.112.0.10/32")); err == nil {
		t.Fatal("Podman cannot keep the k3d network as the node's default route")
	}
}

// The route admits the OpenShell Driver, requires a transport the middleware
// serves and reads the origin's CA only when the operator supplied one.
func TestOpenShellGitRepositoryInputs(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	write := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(directory, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("private-key.pem", string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})))
	write("upstream-cidrs.json", `["11.112.0.2/32"]`)
	policy := map[string]any{"namespaceId": developmentNamespacePlaceholder, "profiles": []string{"git-write"}, "pushRefAllowlist": []string{"refs/heads/review/agent"}}
	writeRegistry := func() {
		t.Helper()
		registry := map[string]any{
			"version": 1, "backendId": "repository-backend", "providerInstanceId": "github-production",
			"appId": "123", "githubInstallationId": "456", "maximumDurationSeconds": 3600,
			"repositories": []any{map[string]any{"repositoryRef": "project", "repositoryId": "789", "repository": "example/project", "namespaces": []any{policy}}},
		}
		data, err := json.Marshal(registry)
		if err != nil {
			t.Fatal(err)
		}
		write("registry.json", string(data))
	}
	r := newRunner(Options{})
	r.env["OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY"] = directory
	load := func() (*developmentRepositoryInputs, error) {
		writeRegistry()
		return r.loadDevelopmentRepositoryInputs("openshell", true)
	}
	for _, transport := range []map[string]any{{}, {"transport": "git-and-draft-pr"}, {"transport": "git-and-draft-pr", "pullRequestBase": ""}, {"transport": "credential-proxy"}} {
		delete(policy, "transport")
		delete(policy, "pullRequestBase")
		for k, v := range transport {
			policy[k] = v
		}
		if _, err := load(); err == nil || !strings.Contains(err.Error(), "OpenShell Git route requires transport") {
			t.Fatalf("transport %v accepted: %v", transport, err)
		}
	}
	policy["transport"] = "git-only"
	inputs, err := load()
	if err != nil || !inputs.openShellGit || !inputs.prepared() || inputs.preparedPort != 443 || inputs.issuerCA != nil {
		t.Fatalf("git-only route input refused or misread: %v %+v", err, inputs)
	}
	policy["transport"], policy["pullRequestBase"] = "git-and-draft-pr", "main"
	if _, err := load(); err != nil {
		t.Fatalf("draft route input refused: %v", err)
	}
	// Without the route, OpenShell still refuses repository inputs.
	if _, err := r.loadDevelopmentRepositoryInputs("openshell", false); err == nil {
		t.Fatal("repository inputs accepted with OpenShell but without the route")
	}
	ca, err := os.ReadFile(writeTestCA(t))
	if err != nil {
		t.Fatal(err)
	}
	write("issuer-ca.crt", string(ca))
	if inputs, err = load(); err != nil || string(inputs.issuerCA) != string(ca) {
		t.Fatalf("issuer CA not read: %v", err)
	}
	write("issuer-ca.crt", "not a certificate")
	if _, err := load(); err == nil || !strings.Contains(err.Error(), "issuer-ca.crt") {
		t.Fatalf("invalid issuer CA accepted: %v", err)
	}
	if err := os.Remove(filepath.Join(directory, "issuer-ca.crt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, "issuer-ca.crt"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := load(); err == nil {
		t.Fatal("an issuer CA directory was accepted")
	}
}

const openShellGitRender = `kind: StatefulSet
metadata: {name: openshell-gateway}
spec:
  template:
    spec:
      volumes:
        - {name: config, configMap: {name: openshell-gateway-config}}
        - {name: oce-git-ca, configMap: {name: occ-openshell-git-ca, items: [{key: ca.crt, path: ca.crt}]}}
      containers:
        - name: openshell-gateway
          args: [--config, /etc/openshell/gateway.toml]
          volumeMounts:
            - {name: config, mountPath: /etc/openshell/gateway.toml, subPath: gateway.toml, readOnly: true}
            - {name: oce-git-ca, mountPath: /etc/openshell/oce-git-ca, readOnly: true}
---
kind: ConfigMap
metadata: {name: openshell-gateway-config}
data:
  gateway.toml: |
    [openshell]
    version = 2
    [[openshell.supervisor.middleware]]
    allow_insecure_transport = false
    audience = "oce-prepared-git"
    grpc_endpoint = "https://openclaw-enterprise-openshell-git.oce-system.svc:8445"
    max_payload_bytes = 4194304
    name = "oce-prepared-git"
    timeout = "3s"
    tls_ca_cert_path = "/etc/openshell/oce-git-ca/ca.crt"
`

func TestOpenShellGitGatewayRenderContract(t *testing.T) {
	state := &developmentState{PlatformNamespace: "oce-system"}
	want := []gatewayMiddleware{openShellGitGatewayMiddleware(state)}
	if err := verifyOpenShellGatewayChart([]byte(openShellGitRender), state, want); err != nil {
		t.Fatalf("valid stock registration: %v", err)
	}
	// The protected profile's verifier must not accept the Git registration, and vice versa.
	if err := verifyProtectedOpenShellChart([]byte(openShellGitRender), state); err == nil || !strings.Contains(err.Error(), "exactly one supervisor middleware, oce-authority") {
		t.Fatalf("protected verifier accepted the Git registration: %v", err)
	}
	second := strings.Replace(openShellGitRender, `    [[openshell.supervisor.middleware]]
    allow_insecure_transport = false`, `    [[openshell.supervisor.middleware]]
    name = "oce-authority"
    [[openshell.supervisor.middleware]]
    allow_insecure_transport = false`, 1)
	for _, tt := range []struct{ render, from, to, want string }{
		{second, "", "", "exactly one supervisor middleware, oce-prepared-git"},
		{openShellGitRender, "allow_insecure_transport = false", "allow_insecure_transport = true", "secure transport"},
		{openShellGitRender, "    allow_insecure_transport = false\n", "", "secure transport"},
		{openShellGitRender, ".svc:8445", ".svc:8446", "required HTTPS endpoint"},
		{openShellGitRender, `timeout = "3s"`, `timeout = "30s"`, "request limits"},
		{openShellGitRender, "max_payload_bytes = 4194304", "max_payload_bytes = 1024", "request limits"},
		{openShellGitRender, `audience = "oce-prepared-git"`, `audience = "oce-egress"`, "audience"},
		{openShellGitRender, "mountPath: /etc/openshell/oce-git-ca, readOnly: true", "mountPath: /etc/openshell/oce-git-ca, readOnly: false", "occ-openshell-git-ca"},
		{openShellGitRender, "name: occ-openshell-git-ca", "name: occ-egress-ca", "occ-openshell-git-ca"},
	} {
		t.Run(tt.to+tt.want, func(t *testing.T) {
			changed := tt.render
			if tt.from != "" {
				changed = strings.Replace(tt.render, tt.from, tt.to, 1)
				if changed == tt.render {
					t.Fatalf("fixture is missing %q", tt.from)
				}
			}
			if err := verifyOpenShellGatewayChart([]byte(changed), state, want); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("want %q, got %v", tt.want, err)
			}
		})
	}
}

// Run the platform installer and the repository step with command fixtures,
// in launcher order. The ordering, mTLS and Git wiring assertions always run.
// When the tools are present the generated Installation is loaded by real
// controller composition (Node) and the OCE chart is rendered by real Helm;
// OCC_TEST_OPENSHELL_STOCK_CHART (an unpacked OpenShell 0.1.4 deploy/helm/openshell)
// also renders the stock Gateway chart with the middleware registration.
func TestOpenShellGitProfileWiresStockGatewayAndWorker(t *testing.T) {
	stockChart := os.Getenv("OCC_TEST_OPENSHELL_STOCK_CHART")
	realNode, nodeErr := exec.LookPath("node")
	helm, helmErr := exec.LookPath(cmp.Or(os.Getenv("OCC_HELM_BIN"), "helm"))
	if stockChart != "" && helmErr != nil {
		t.Fatalf("OCC_TEST_OPENSHELL_STOCK_CHART requires Helm: %v", helmErr)
	}
	state := kubernetesOnlyOpenShellState(t)
	state.OpenShellGit = true
	state.SandboxNetworkPolicies = []any{map[string]any{"name": "example-fetch", "binaries": []any{map[string]any{"path": "/usr/bin/curl"}}, "endpoints": []any{map[string]any{"host": "example.com", "ports": []any{443}}}}}
	assets := &openShellDevelopmentAssets{gatewayChart: cmp.Or(stockChart, "/stock/openshell-gateway"), gatewayImage: "registry.example/gateway@" + profileTestDigest,
		sandboxImage: "registry.example/sandbox@" + profileTestDigest, supervisorImage: "registry.example/supervisor@" + profileTestDigest,
		workspaceResources: []any{map[string]any{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]string{"name": "openshell-sandbox"}}}}
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, _ := x509.MarshalPKIXPublicKey(public)
	publicPEM := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}))
	// Save every OCE release's values; the repository upgrade must keep the platform's.
	t.Setenv("RELEASE_DIR", state.directory)
	saveRelease := `n=$(ls "$RELEASE_DIR"/release-*.json 2>/dev/null | wc -l); /bin/cp "$RELEASE_DIR/helm-values.json" "$RELEASE_DIR/release-$n.json"`
	t.Setenv("PATH", t.TempDir())
	commands := fakeProfileCommands(t, map[string]string{
		"kubectl": `"get namespace oce-system") ;;
"apply -f "*) ;;
"get secret openshell-gateway-jwt-keys --namespace oce-system -o jsonpath={.data.kid}") echo dGVzdC1raWQ= ;;
"get secret openshell-gateway-jwt-keys --namespace oce-system -o jsonpath={.data.public\\.pem}") echo ` + publicPEM + ` ;;
"get node k3d-occ-dev-owned-server-0 -o json") echo '{"spec":{"podCIDR":"10.42.0.0/24"}}' ;;
"get service openshell-gateway --namespace oce-system -o jsonpath={.spec.clusterIP}") echo 10.43.0.50 ;;
` + controlPlaneKubectlCases + `
"-n oce-system create secret "*) ;;
"-n oce-system rollout status deployment/openclaw-enterprise-worker --timeout 1m0s") ;;
"-n kube-system rollout restart deployment/coredns") ;;
"-n kube-system rollout status deployment/coredns --timeout 1m0s") ;;
"rollout status statefulset/openshell-gateway --namespace oce-system --timeout 1m0s") ;;`,
		"docker": `"exec k3d-occ-dev-owned-server-0 ip route get 10.42.0.2") echo '10.42.0.2 dev cni0 src 10.42.0.1' ;;
"network connect --gw-priority -100 occ-fixture k3d-occ-dev-owned-server-0") ;;
` + controlPlaneNetworkCase,
		"helm": `"upgrade --install openshell-gateway "*) ;;
"upgrade openshell-gateway "*) ;;
"upgrade "*"openclaw-enterprise deploy/helm/openclaw-enterprise "*) ` + saveRelease + ` ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "docker"
	r.env[openShellGitFixtureNetworkSelector] = "occ-fixture"
	if err := r.installDevelopmentPlatform(context.Background(), state, developmentPlatformInputs{
		openShell: assets, runtimeImage: "registry.example/runtime@" + profileTestDigest,
		controllerImage: "registry.example/controller@" + profileTestDigest, postgresImage: "registry.example/postgres@" + profileTestDigest,
	}, time.Minute); err != nil {
		t.Fatalf("platform packaging failed: %v\n%s", err, strings.Join(commands(), "\n"))
	}
	if state.gatewayKeyID != "test-kid" {
		t.Fatal("native PKI key identifier was not read")
	}

	appKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	issuer, _, err := generateDevelopmentTLS("issuer", "fixture CA", []string{"github.com", "api.github.com"})
	if err != nil {
		t.Fatal(err)
	}
	inputs := &developmentRepositoryInputs{
		registry: map[string]any{"version": 1, "backendId": "skipper-fixture", "providerInstanceId": "fixture", "appId": "1", "githubInstallationId": "2", "maximumDurationSeconds": float64(3600), "repositories": []any{map[string]any{
			"repositoryRef": "skipper", "repository": "fixture/skipper", "repositoryId": "7",
			"namespaces": []any{map[string]any{"namespaceId": developmentNamespacePlaceholder, "profiles": []any{"git-write"}, "pushRefAllowlist": []any{"refs/heads/review/skipper"}, "transport": "git-and-draft-pr", "pullRequestBase": "main"}},
		}}},
		backendID: "skipper-fixture", upstreamCIDRs: []string{"11.112.0.10/32"},
		appKey:   pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(appKey)}),
		issuerCA: issuer["issuer-ca.crt"], openShellGit: true, preparedPort: 443,
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"data":[{"repositoryRef":"skipper","allowedProfiles":["git-write"]}],"meta":{}}`)
	}))
	defer server.Close()
	if err := r.attachOpenShellGitFixture(context.Background(), state, inputs, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := r.enableDevelopmentRepository(context.Background(), state, inputs, "registry.example/repository@"+profileTestDigest, "ns_initial", readinessClient(t, server.URL), assets, time.Minute); err != nil {
		t.Fatalf("repository wiring failed: %v\n%s", err, strings.Join(commands(), "\n"))
	}

	log := commands()
	find := func(operation string) int {
		t.Helper()
		i := slices.IndexFunc(log, func(s string) bool { return strings.Contains(s, operation) })
		if i < 0 {
			t.Fatalf("missing operation %s\n%s", operation, strings.Join(log, "\n"))
		}
		return i
	}
	gateway := find("helm upgrade --install openshell-gateway ")
	kid := find("jsonpath={.data.kid}")
	platform := find("helm upgrade --install openclaw-enterprise ")
	attach := find("docker network connect --gw-priority -100 occ-fixture ")
	dns := find("kubectl apply -f " + filepath.Join(state.directory, "openshell-git-fixture-dns.json"))
	material := find("kubectl apply -f " + filepath.Join(state.directory, "openshell-git-material.json"))
	repository := slices.IndexFunc(log[platform+1:], func(s string) bool { return strings.Contains(s, "openclaw-enterprise deploy/helm/openclaw-enterprise") }) + platform + 1
	worker := find("rollout status deployment/openclaw-enterprise-worker")
	register := find("helm upgrade openshell-gateway ")
	ready := find("kubectl rollout status statefulset/openshell-gateway ")
	if !(gateway < kid && kid < platform && platform < attach && attach < dns && dns < material && material < repository && repository < worker && worker < register && register < ready) {
		t.Fatalf("expected Gateway, key ID, OCE, fixture, material, repository release, worker, then registration\n%s", strings.Join(log, "\n"))
	}
	// Stock Gateway startup calls Describe: register only once the worker serves it.
	if !strings.Contains(log[gateway], "--wait") || !strings.Contains(log[gateway], filepath.Join(state.directory, "openshell-git-values.json")) ||
		!strings.Contains(log[register], "--wait") || !strings.Contains(log[register], filepath.Join(state.directory, "openshell-git-middleware-values.json")) {
		t.Fatal("incorrect Gateway values or readiness gates")
	}
	all := strings.Join(log, "\n")
	if strings.Contains(all, "create secret generic openshell-gateway-jwt-keys") || strings.Contains(all, "worker.replicaCount") {
		t.Fatal("native PKI must stay with OpenShell and the worker must start normally")
	}

	gatewayValues := readJSONFile(t, filepath.Join(state.directory, "openshell-git-values.json"))
	if _, found := gatewayValues["gatewayConfig"]; found || field(t, gatewayValues, "server", "tls", "enableMtls") != true || field(t, gatewayValues, "pkiInitJob", "enabled") != true {
		t.Fatal("the first Gateway release must serve native mTLS without the registration")
	}
	middleware := readJSONFile(t, filepath.Join(state.directory, "openshell-git-middleware-values.json"))
	registration := field(t, middleware, "gatewayConfig", "openshell.supervisor.middleware", 0).(map[string]any)
	if registration["grpc_endpoint"] != "https://openclaw-enterprise-openshell-git.oce-system.svc:8445" || registration["allow_insecure_transport"] != false {
		t.Fatalf("unexpected registration %v", registration)
	}

	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var installation map[string]any
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	backend := field(t, installation, "backend", 0).(map[string]any)
	if field(t, backend, "configuration", "auth", "mode") != "mtls" || field(t, backend, "drivers", "credential_proxy") != nil {
		t.Fatal("the OpenShell Backend must use mTLS without selecting the Credential Proxy")
	}
	if _, found := installation["drivers"].(map[string]any)["credential_proxy"]; found {
		t.Fatal("the route must not select credential_proxy")
	}
	repo := field(t, installation, "drivers", "repo").(map[string]any)
	if field(t, repo, "openShell", "authority", "keyId") != "test-kid" || field(t, repo, "openShell", "registrationName") != openShellGitRegistration ||
		field(t, repo, "preparedGitHub", "apiOrigin") != openShellGitAPIOrigin || field(t, repo, "preparedGitHub", "issuerCaPath") == nil {
		t.Fatalf("unexpected drivers.repo %v", repo)
	}
	sandbox := field(t, installation, "drivers", "sandbox", "configuration").(map[string]any)
	if name := sandboxPoliciesReachGitHub(field(t, sandbox, "policy", "networkPolicies").([]any)); name != "" {
		t.Fatalf("policy %s still reaches GitHub", name)
	}
	manifestByKind(t, field(t, sandbox, "gateway", "networkPolicyResources").([]any), "NetworkPolicy", "allow-openshell-git-authority")

	values := readJSONFile(t, filepath.Join(state.directory, "helm-values.json"))
	if field(t, values, "repositoryCredentials", "authority") != "prepared-git" || field(t, values, "repositoryCredentials", "upstreamPort") != float64(443) ||
		field(t, values, "openshellGit", "port") != float64(openShellGitPort) || field(t, values, "backend", "openshell", "clientSecretName") != "openshell-client-tls" {
		t.Fatalf("unexpected Helm values %v", values)
	}
	if _, found := values["egressAuthority"]; found {
		t.Fatal("the chart refuses openshellGit with egressAuthority")
	}
	// The registry and Helm values carry no private key; the App key and custody key stay in Secrets.
	for _, name := range []string{"helm-values.json", "installation.yaml", "openshell-git-middleware-values.json"} {
		content, _ := os.ReadFile(filepath.Join(state.directory, name))
		if strings.Contains(string(content), "PRIVATE KEY") {
			t.Fatalf("%s contains private key material", name)
		}
	}
	dnsConfig := readJSONFile(t, filepath.Join(state.directory, "openshell-git-fixture-dns.json"))
	if pin := field(t, dnsConfig, "data", openShellGitDNSConfigMapKey).(string); !strings.Contains(pin, "11.112.0.10 github.com") || !strings.Contains(pin, "11.112.0.10 api.github.com") {
		t.Fatalf("fixture DNS pin %q", pin)
	}

	if nodeErr != nil {
		t.Log("node not found; skipping the real startup parse of the generated Installation")
	} else {
		program := `import assert from 'node:assert/strict';
import {loadInstallationConfiguration} from './apps/controller/src/composition/installation-config.ts';
const loaded = await loadInstallationConfiguration({mode:'production', environment:{OCC_CONFIG_PATH:process.argv[1]}});
assert.equal(loaded.installation.backend[0].configuration.auth.mode,'mtls');
assert.equal(loaded.proxyDriver,undefined);
assert.equal(loaded.openShellGit.configuration.registrationName,'oce-prepared-git');
assert.equal(loaded.openShellGit.configuration.authority.keyId,'test-kid');
assert.equal(loaded.openShellGit.configuration.authority.audience,'oce-prepared-git');
assert.equal(loaded.preparedRepositoryGit.apiOrigin,'https://api.github.com');
`
		// Startup reads the files the chart mounts under /etc/openclaw. Root a copy
		// of the Installation at a temporary directory holding the generated material.
		root := t.TempDir()
		registry := readJSONFile(t, filepath.Join(state.directory, "repository-registry.json"))
		client, _, err := generateDevelopmentTLS("client", "OpenShell client CA", []string{"openshell-gateway"})
		if err != nil {
			t.Fatal(err)
		}
		generated := func(name string) []byte {
			data, err := os.ReadFile(filepath.Join(state.directory, name))
			if err != nil {
				t.Fatal(err)
			}
			return data
		}
		publicKey, _ := base64.StdEncoding.DecodeString(publicPEM)
		for path, data := range map[string][]byte{
			"repository-registry/registry.json":   []byte(field(t, registry, "data", "registry.json").(string)),
			"repository-ca/ca.crt":                generated("repository-ca.crt"),
			"prepared-repository/private-key.pem": generated("repository-app-key.pem"),
			"prepared-repository/custody.key":     generated("repository-custody.key"),
			"prepared-repository-ca/ca.crt":       inputs.issuerCA,
			"openshell-git/tls.crt":               generated("openshell-git-tls.crt"),
			"openshell-git/tls.key":               generated("openshell-git-tls.key"),
			"openshell-git/gateway-public.pem":    publicKey,
			"openshell/ca.crt":                    client["client-ca.crt"],
			"openshell/tls.crt":                   client["client-tls.crt"],
			"openshell/tls.key":                   client["client-tls.key"],
		} {
			target := filepath.Join(root, "etc", "openclaw", path)
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, data, 0600); err != nil {
				t.Fatal(err)
			}
		}
		parsedPath := filepath.Join(root, "installation.yaml")
		if err := os.WriteFile(parsedPath, []byte(strings.ReplaceAll(string(data), "/etc/openclaw/", root+"/etc/openclaw/")), 0600); err != nil {
			t.Fatal(err)
		}
		parse := exec.Command(realNode, "--input-type=module", "-e", program, parsedPath)
		parse.Dir = state.Repository
		if out, err := parse.CombinedOutput(); err != nil {
			t.Fatalf("real startup rejected the generated Installation: %v\n%s", err, out)
		}
	}
	if helmErr != nil {
		t.Log("helm not found (set OCC_HELM_BIN); skipping chart renders")
		return
	}
	rendered := renderDevelopmentChart(t, helm, state, "openclaw-enterprise", "deploy/helm/openclaw-enterprise", "helm-values.json")
	if !strings.Contains(string(rendered), "name: openclaw-enterprise-openshell-git") {
		t.Fatal("the OCE chart did not render the OpenShell Git Service")
	}
	if stockChart == "" {
		t.Log("OCC_TEST_OPENSHELL_STOCK_CHART unset; skipping the stock Gateway chart render")
		return
	}
	out := renderDevelopmentChart(t, helm, state, openShellGatewayService, stockChart,
		"openshell-git-middleware-values.json", "--set", "agentSandbox.preflight.enabled=false", "--set", "fullnameOverride=openshell-gateway")
	if err := verifyOpenShellGatewayChart(out, state, []gatewayMiddleware{openShellGitGatewayMiddleware(state)}); err != nil {
		t.Fatal(err)
	}
}

// The derived supervisor image is staged from an unstarted container: its
// bundle gains the selected CA readable by the non-root supervisor, and every
// staging artifact is removed, including the image when a later step fails.
func TestOpenShellSupervisorTrustDerivesAndCleansUp(t *testing.T) {
	work := t.TempDir()
	captured := filepath.Join(work, "captured.crt")
	failRemove := filepath.Join(work, "fail-remove")
	container := "openclaw-development-supervisor-trust-c1"
	derived := "openclaw-development/openshell-supervisor-trust:c1"
	commands := fakeProfileCommands(t, map[string]string{
		"docker": `"image inspect supervisor@sha256:abc") echo '[{}]' ;;
"image inspect ` + derived + `") exit 1 ;;
"create --name ` + container + ` supervisor@sha256:abc") echo created ;;
"cp ` + container + `:/etc/ssl/certs/ca-certificates.crt "*) printf 'BASE\n' > "$3" ;;
"cp "*" ` + container + `:/etc/ssl/certs/ca-certificates.crt") cp "$2" ` + shellQuote(captured) + `; stat -c %a "$2" > ` + shellQuote(captured) + `.mode ;;
"commit ` + container + ` ` + derived + `") echo sha256:def ;;
"rm --force ` + container + `") test -e ` + shellQuote(failRemove) + ` && exit 1; echo removed ;;
"image rm ` + derived + `") echo untagged ;;`,
	})
	ca := writeTestCA(t)
	caPEM, err := os.ReadFile(ca)
	if err != nil {
		t.Fatal(err)
	}
	r := newRunner(Options{})
	r.engine = "docker"
	state := &developmentState{Cluster: "c1"}
	// A restrictive umask must not narrow the bundle the supervisor reads.
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	image, release, err := r.trustOpenShellSupervisor(context.Background(), state, work, "supervisor@sha256:abc", true, ca)
	if err != nil || image != derived {
		t.Fatalf("derive: %q %v", image, err)
	}
	bundle, err := os.ReadFile(captured)
	if err != nil || !strings.HasPrefix(string(bundle), "BASE\n") || !strings.HasSuffix(string(bundle), string(caPEM)) {
		t.Fatalf("bundle does not append the CA: %v", err)
	}
	if mode, _ := os.ReadFile(captured + ".mode"); strings.TrimSpace(string(mode)) != "644" {
		t.Fatalf("bundle mode %q: the non-root supervisor must read it", mode)
	}
	if _, err := os.Stat(filepath.Join(work, "supervisor-ca-certificates.crt")); !os.IsNotExist(err) {
		t.Fatalf("local bundle copy left behind: %v", err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	log := strings.Join(commands(), "\n")
	for _, want := range []string{"docker rm --force " + container, "docker image rm " + derived} {
		if !strings.Contains(log, want) {
			t.Fatalf("missing %q in:\n%s", want, log)
		}
	}
	if err := os.WriteFile(failRemove, nil, 0600); err != nil {
		t.Fatal(err)
	}
	before := len(commands())
	if _, _, err := r.trustOpenShellSupervisor(context.Background(), state, work, "supervisor@sha256:abc", true, ca); err == nil {
		t.Fatal("a failed staging cleanup was ignored")
	}
	if after := strings.Join(commands()[before:], "\n"); !strings.Contains(after, "docker image rm "+derived) {
		t.Fatalf("the committed image survived a failed cleanup:\n%s", after)
	}
}
