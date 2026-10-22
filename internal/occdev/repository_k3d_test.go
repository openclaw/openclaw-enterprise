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

	"go.yaml.in/yaml/v3"
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
	policy := registry["repositories"].([]any)[0].(map[string]any)["namespaces"].([]any)[0].(map[string]any)
	// The worker prepares every credential and refuses other grants at startup: refuse them first.
	for _, change := range []func(){
		func() { delete(policy, "transport") },
		func() { policy["profiles"] = []any{"git-read"} },
		func() { policy["pushRefAllowlist"] = []any{"refs/heads/a", "refs/heads/b"} },
		func() { policy["transport"] = "git-and-draft-pr" },
	} {
		registry = preparedRepositoryRegistry()
		policy = registry["repositories"].([]any)[0].(map[string]any)["namespaces"].([]any)[0].(map[string]any)
		change()
		writeRegistry()
		if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil || !strings.Contains(err.Error(), "prepared repository access requires") {
			t.Fatalf("an unprepared grant %v was not refused before effects: %v", policy, err)
		}
	}
	policy["pullRequestBase"] = "develop"
	writeRegistry()
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err != nil {
		t.Fatalf("a draft PR grant was rejected: %v", err)
	}
	registry = preparedRepositoryRegistry()
	policy = registry["repositories"].([]any)[0].(map[string]any)["namespaces"].([]any)[0].(map[string]any)
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
	policy["pushRefAllowlist"] = []any{"refs/heads/skipper"}
	writeRegistry()
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil {
		t.Fatal("a qualification grant outside review refs was accepted")
	}
	policy["pushRefAllowlist"] = []any{"refs/heads/review/skipper"}
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
	if !strings.Contains(strings.Join(commands(), "\n"), "create secret generic occ-repository-custody") {
		t.Fatal("the worker custody key Secret was not created")
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var installation map[string]any
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	if _, found := field(t, installation, "drivers").(map[string]any)["repo"]; found {
		t.Fatal("startup refuses the retired drivers.repo selection")
	}
	service := readJSONFile(t, filepath.Join(state.directory, "repository-service.json"))
	if field(t, service, "backend", "kind") != "github-prepared-git-registry" {
		t.Fatalf("the repository service refuses the retired App signing backend: %v", service["backend"])
	}

	if nodeErr != nil {
		t.Log("node not found; skipping the real startup parse of the generated Installation")
	} else {
		program := `import assert from 'node:assert/strict';
import {loadInstallationConfiguration} from './apps/controller/src/composition/installation-config.ts';
const loaded = await loadInstallationConfiguration({mode:'production', environment:{OCC_CONFIG_PATH:process.argv[1]}});
assert.equal(loaded.repositoryGitDriver, undefined);
assert.equal(typeof loaded.nativeRepositorySender, 'object');
assert.equal(loaded.repositoryOwner.backendId, 'repository-backend');
assert.equal(loaded.preparedRepositoryGit.apiOrigin, process.argv[2] || undefined);
`
		// Startup reads the files the chart mounts under /etc/openclaw. Root a copy
		// of the Installation at a temporary directory holding the generated material.
		root := t.TempDir()
		generated := func(name string) []byte {
			data, err := os.ReadFile(filepath.Join(state.directory, name))
			if err != nil {
				t.Fatal(err)
			}
			return data
		}
		registry := readJSONFile(t, filepath.Join(state.directory, "repository-registry.json"))
		for path, data := range map[string][]byte{
			"repository-registry/registry.json":   []byte(field(t, registry, "data", "registry.json").(string)),
			"repository-ca/ca.crt":                generated("repository-ca.crt"),
			"prepared-repository/private-key.pem": generated("repository-app-key.pem"),
			"prepared-repository/custody.key":     generated("repository-custody.key"),
			"prepared-repository-ca/ca.crt":       inputs.issuerCA,
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
		parse := exec.Command(realNode, "--input-type=module", "-e", program, parsedPath, origin)
		parse.Dir = state.Repository
		if out, err := parse.CombinedOutput(); err != nil {
			t.Fatalf("real startup rejected the generated Installation: %v\n%s", err, out)
		}
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
