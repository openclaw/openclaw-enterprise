package occdev

import (
	"cmp"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json/v2"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// preparedRepositoryRegistry is an input registry the worker can prepare: one
// Git-only grant with exactly one writable review ref.
func preparedRepositoryRegistry() map[string]any {
	return map[string]any{
		"version": 1, "backendId": "repository-backend", "providerInstanceId": "github-production",
		"appId": "123", "githubInstallationId": "456", "maximumDurationSeconds": float64(3600),
		"repositories": []any{map[string]any{"repositoryRef": "project", "repositoryId": "789", "repository": "example/project", "namespaces": []any{map[string]any{
			"namespaceId": developmentNamespacePlaceholder, "profiles": []any{"git-write"}, "transport": "git-only", "pushRefAllowlist": []any{"refs/heads/review/skipper"},
		}}}},
	}
}

func testAppKeyPEM(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
}

func TestDevelopmentRepositoryCertificateTrustsOnlyItsBrokerHost(t *testing.T) {
	directory := t.TempDir()
	host := "git.oce-system.svc.cluster.local"
	if err := writeDevelopmentRepositoryTLS(directory, host); err != nil {
		t.Fatal(err)
	}
	caPEM, err := os.ReadFile(filepath.Join(directory, "repository-ca.crt"))
	if err != nil {
		t.Fatal(err)
	}
	leafPEM, err := os.ReadFile(filepath.Join(directory, "repository-tls.crt"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		t.Fatal("generated CA was not valid PEM")
	}
	block, _ := pem.Decode(leafPEM)
	if block == nil {
		t.Fatal("generated leaf was not valid PEM")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: host}); err != nil {
		t.Fatalf("exact broker host did not verify: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "git.other.svc.cluster.local"}); err == nil {
		t.Fatal("certificate unexpectedly authorized another broker hostname")
	}
	info, err := os.Stat(filepath.Join(directory, "repository-tls.key"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatal("repository-tls.key is not private")
	}
	if _, err := os.Stat(filepath.Join(directory, "repository-ca.key")); !os.IsNotExist(err) {
		t.Fatalf("repository CA key was written: %v", err)
	}
}

func TestDevelopmentRepositoryInputsRejectUnapprovedNamespacePolicy(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "private-key.pem"), testAppKeyPEM(t), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "upstream-cidrs.json"), []byte(`["192.0.2.10/32"]`), 0600); err != nil {
		t.Fatal(err)
	}
	registry := preparedRepositoryRegistry()
	writeRegistry := func() {
		t.Helper()
		data, err := json.Marshal(registry)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "registry.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeRegistry()
	runner := newRunner(Options{})
	runner.env["OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY"] = directory
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err != nil {
		t.Fatalf("approved input rejected: %v", err)
	}
	var policy map[string]any
	reset := func() {
		registry = preparedRepositoryRegistry()
		policy = registry["repositories"].([]any)[0].(map[string]any)["namespaces"].([]any)[0].(map[string]any)
	}
	// The worker and broker refuse other grants only at startup, after the
	// cluster effects: the launcher refuses them first.
	for _, change := range []func(){
		func() { delete(policy, "transport") },
		func() { policy["profiles"] = []any{"git-read"} },
		func() { policy["pushRefAllowlist"] = []any{"refs/heads/a", "refs/heads/b"} },
		func() { policy["pushRefAllowlist"] = []any{"refs/heads/review/*"} },
		func() { policy["pullRequestBase"] = "main" },
		func() { policy["transport"] = "git-and-draft-pr" },
		func() { policy["transport"], policy["pullRequestBase"] = "git-and-draft-pr", "review/skipper" },
	} {
		reset()
		change()
		writeRegistry()
		if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil || !strings.Contains(err.Error(), "prepared repository access requires") {
			t.Fatalf("an unprepared grant %v was not refused before effects: %v", policy, err)
		}
	}
	reset()
	policy["transport"], policy["pullRequestBase"] = "git-and-draft-pr", "develop"
	writeRegistry()
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err != nil {
		t.Fatalf("a draft PR grant was rejected: %v", err)
	}
	reset()
	// Provider egress must name specific authorized destinations, not a broad range.
	if err := os.WriteFile(filepath.Join(directory, "upstream-cidrs.json"), []byte(`["192.0.2.0/24"]`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil {
		t.Fatal("broad repository egress range was accepted")
	}
	if err := os.WriteFile(filepath.Join(directory, "upstream-cidrs.json"), []byte(`["192.0.2.10/32"]`), 0600); err != nil {
		t.Fatal(err)
	}
	policy["namespaceId"] = "another-namespace"
	writeRegistry()
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil {
		t.Fatal("a policy targeting another Namespace was accepted")
	}

	policy["namespaceId"] = developmentNamespacePlaceholder
	runner.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = "0"
	runner.env["OCC_DEVELOPMENT_PREPARED_GIT_HOST_IP"] = "172.17.0.1"
	runner.env["OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN"] = "https://172.17.0.1:8443"
	for name, value := range map[string]string{"upstream-cidrs.json": `["172.17.0.1/32"]`, "issuer-ca.crt": "test public CA"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Qualification also needs a review ref and, for a draft, the main base.
	for _, change := range []func(){
		func() { policy["pushRefAllowlist"] = []any{"refs/heads/skipper"} },
		func() { policy["transport"], policy["pullRequestBase"] = "git-and-draft-pr", "develop" },
	} {
		reset()
		change()
		writeRegistry()
		if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil || !strings.Contains(err.Error(), "prepared Git qualification requires") {
			t.Fatalf("qualification grant %v was not refused: %v", policy, err)
		}
	}
	reset()
	policy["transport"], policy["pullRequestBase"] = "git-and-draft-pr", "main"
	writeRegistry()
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err != nil {
		t.Fatalf("a qualification draft PR grant was rejected: %v", err)
	}
	reset()
	writeRegistry()
	if _, err := runner.loadDevelopmentRepositoryInputs("openshell"); err == nil {
		t.Fatal("must not select OpenShell for Compute-owned qualification")
	}
	inputs, err := runner.loadDevelopmentRepositoryInputs("none")
	if err != nil || inputs.preparedPort != 8443 {
		t.Fatalf("expected exact private qualified Git origin: %v", err)
	}
	runner.env["OCC_DEVELOPMENT_PREPARED_GIT_HOST_IP"] = "172.17.0.2"
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil {
		t.Fatal("unexpected Git issuer host accepted")
	}
}

// occ dev up must generate a repository Installation that real startup and the
// chart accept: native Git with worker-prepared custody, never drivers.repo.
func TestDevelopmentRepositoryInstallationPassesStartup(t *testing.T) {
	realNode, nodeErr := exec.LookPath("node")
	helm, helmErr := exec.LookPath(cmp.Or(os.Getenv("OCC_HELM_BIN"), "helm"))
	for _, origin := range []string{"", "https://172.17.0.1:8443"} {
		t.Run(cmp.Or(origin, "github.com"), func(t *testing.T) {
			testDevelopmentRepositoryInstallation(t, origin, realNode, nodeErr, helm, helmErr)
		})
	}
}

func testDevelopmentRepositoryInstallation(t *testing.T, origin, realNode string, nodeErr error, helm string, helmErr error) {
	state := kubernetesOnlyOpenShellState(t)
	state.SandboxDriver = "none"
	t.Setenv("PATH", t.TempDir())
	commands := fakeProfileCommands(t, map[string]string{
		"kubectl": `"get namespace oce-system") ;;
"apply -f "*) ;;
"get node k3d-occ-dev-owned-server-0 -o json") echo '{"spec":{"podCIDR":"10.42.0.0/24"}}' ;;
` + controlPlaneKubectlCases + `
"-n oce-system create secret "*) ;;
"-n oce-system rollout status deployment/openclaw-enterprise-worker --timeout 1m0s") ;;`,
		"docker": `"exec k3d-occ-dev-owned-server-0 ip route get 10.42.0.2") echo '10.42.0.2 dev cni0 src 10.42.0.1' ;;
` + controlPlaneNetworkCase,
		"helm": `"upgrade "*"openclaw-enterprise deploy/helm/openclaw-enterprise "*) ;;`,
	})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "docker"
	if err := r.installDevelopmentPlatform(context.Background(), state, developmentPlatformInputs{
		runtimeImage: "registry.example/runtime@" + profileTestDigest, controllerImage: "registry.example/controller@" + profileTestDigest,
		postgresImage: "registry.example/postgres@" + profileTestDigest,
	}, time.Minute); err != nil {
		t.Fatalf("platform packaging failed: %v\n%s", err, strings.Join(commands(), "\n"))
	}
	inputs := &developmentRepositoryInputs{registry: preparedRepositoryRegistry(), backendID: "repository-backend", upstreamCIDRs: []string{"192.0.2.10/32"}, appKey: testAppKeyPEM(t)}
	if origin != "" {
		issuer, _, err := generateDevelopmentTLS("issuer", "fixture CA", []string{"172.17.0.1"})
		if err != nil {
			t.Fatal(err)
		}
		inputs.preparedOrigin, inputs.preparedPort, inputs.issuerCA, inputs.upstreamCIDRs = origin, 8443, issuer["issuer-ca.crt"], []string{"172.17.0.1/32"}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"data":[{"repositoryRef":"project","allowedProfiles":["git-write"]}],"meta":{}}`)
	}))
	defer server.Close()
	if err := r.enableDevelopmentRepository(context.Background(), state, inputs, "registry.example/repository@"+profileTestDigest, "ns_initial", readinessClient(t, server.URL), time.Minute); err != nil {
		t.Fatalf("repository wiring failed: %v\n%s", err, strings.Join(commands(), "\n"))
	}
	// Run the real startup paths on the generated files first: the Installation
	// loader shared by the API and worker, and the repository service's
	// projected-input loader. Each refuses a retired selection with its own
	// error. The worker's prepared Git owner needs PostgreSQL; it is not run here.
	if nodeErr != nil {
		t.Log("node not found; skipping the real startup parse of the generated files")
	} else {
		parseGeneratedRepositoryStartup(t, realNode, state, inputs, origin)
	}
	if !strings.Contains(strings.Join(commands(), "\n"), "create secret generic occ-repository-custody") {
		t.Fatal("the worker custody key Secret was not created")
	}
	// The worker refuses a custody key that is not exactly 32 bytes.
	if info, err := os.Stat(filepath.Join(state.directory, "repository-custody.key")); err != nil || info.Size() != 32 || info.Mode().Perm() != 0600 {
		t.Fatalf("the worker custody key must be 32 private bytes: %v %v", info, err)
	}
	if helmErr != nil {
		t.Log("helm not found (set OCC_HELM_BIN); skipping the chart render")
		return
	}
	rendered := string(renderDevelopmentChart(t, helm, state, "openclaw-enterprise", "deploy/helm/openclaw-enterprise", "helm-values.json"))
	if !strings.Contains(rendered, "mountPath: /etc/openclaw/prepared-repository\n") {
		t.Fatal("the chart did not mount the worker's prepared repository custody")
	}
}

// parseGeneratedRepositoryStartup loads the generated Installation and broker
// configuration with the controller's own startup code. The chart mounts these
// files under /etc/openclaw; a copy rooted in a temporary directory stands in.
func parseGeneratedRepositoryStartup(t *testing.T, realNode string, state *developmentState, inputs *developmentRepositoryInputs, origin string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The broker derives its prepared-material socket beside the control socket,
	// and a Unix socket path must stay short.
	sockets, err := os.MkdirTemp("/tmp", "rc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockets) })
	if sockets, err = filepath.EvalSymlinks(sockets); err != nil {
		t.Fatal(err)
	}
	// A file the launcher did not generate stays empty, so the loaders report what is missing.
	generated := func(name string) []byte {
		data, err := os.ReadFile(filepath.Join(state.directory, name))
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		return []byte(strings.NewReplacer(
			"/run/openclaw/repository-control/private/control.sock", filepath.Join(sockets, "private", "control.sock"),
			"/etc/openclaw/", root+"/etc/openclaw/",
		).Replace(string(data)))
	}
	registry := []byte(field(t, readJSONFile(t, filepath.Join(state.directory, "repository-registry.json")), "data", "registry.json").(string))
	for path, data := range map[string][]byte{
		"installation.yaml":                                generated("installation.yaml"),
		"service-config.json":                              generated("repository-service.json"),
		"etc/openclaw/repository-registry/registry.json":   registry,
		"etc/openclaw/repository-ca/ca.crt":                generated("repository-ca.crt"),
		"etc/openclaw/prepared-repository/private-key.pem": generated("repository-app-key.pem"),
		"etc/openclaw/prepared-repository/custody.key":     generated("repository-custody.key"),
		"etc/openclaw/prepared-repository-ca/ca.crt":       inputs.issuerCA,
		"broker-tls.crt":                                   generated("repository-tls.crt"),
		"broker-tls.key":                                   generated("repository-tls.key"),
	} {
		target := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	program := `import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadInstallationConfiguration } from './apps/controller/src/composition/installation-config.ts';
import { prepareProjectedInputs } from './apps/controller/src/composition/repository-credentials/projected-inputs.ts';
import { createSystemClock } from './apps/controller/src/drivers/repo/credentials/clock.ts';
const [root, sockets, origin] = process.argv.slice(1);
const loaded = await loadInstallationConfiguration({ mode: 'production', environment: { OCC_CONFIG_PATH: join(root, 'installation.yaml') } });
assert.equal(loaded.repositoryGitDriver, undefined);
assert.equal(typeof loaded.nativeRepositorySender, 'object');
assert.equal(loaded.repositoryOwner.backendId, 'repository-backend');
assert.equal(loaded.preparedRepositoryGit.apiOrigin, origin || undefined);
// Lay the broker inputs out as Kubernetes projects the chart's Secret and ConfigMap volumes.
const project = async (directory, files) => {
  await mkdir(join(directory, '..generation'), { recursive: true, mode: 0o755 });
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(directory, '..generation', name), await readFile(join(root, source)), { mode: 0o440 });
    await symlink('..data/' + name, join(directory, name));
  }
  await symlink('..generation', join(directory, '..data'));
};
await project(join(root, 'inputs'), { 'config.json': 'service-config.json', 'tls.crt': 'broker-tls.crt', 'tls.key': 'broker-tls.key' });
await project(join(root, 'registry'), { 'registry.json': 'etc/openclaw/repository-registry/registry.json' });
await mkdir(join(root, 'private-volume'), { mode: 0o755 });
const broker = await prepareProjectedInputs({
  inputsDirectory: join(root, 'inputs'),
  registryFile: join(root, 'registry', 'registry.json'),
  privateDirectory: join(root, 'private-volume', 'private'),
  controlSocket: join(sockets, 'private', 'control.sock'),
  expectedOrigin: 'https://git.oce-system.svc.cluster.local',
  backendId: 'repository-backend',
  authority: 'prepared-git',
}, createSystemClock());
assert.equal(broker.authority, 'github-prepared-git-registry');
assert.equal(broker.upstreamCa !== undefined, origin !== '');
broker.close();
`
	parse := exec.Command(realNode, "--input-type=module", "-e", program, root, sockets, origin)
	parse.Dir = state.Repository
	if out, err := parse.CombinedOutput(); err != nil {
		t.Fatalf("real startup rejected the generated repository configuration: %v\n%s", err, out)
	}
}
