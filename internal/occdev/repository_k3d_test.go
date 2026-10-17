package occdev

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json/v2"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

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
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(filepath.Join(directory, "private-key.pem"), keyPEM, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "upstream-cidrs.json"), []byte(`["192.0.2.10/32"]`), 0600); err != nil {
		t.Fatal(err)
	}
	registry := map[string]any{
		"version": 1, "backendId": "repository-backend", "providerInstanceId": "github-production",
		"appId": "123", "githubInstallationId": "456", "maximumDurationSeconds": 3600,
		"repositories": []any{map[string]any{"repositoryRef": "project", "repositoryId": "789", "repository": "example/project", "namespaces": []any{map[string]any{"namespaceId": developmentNamespacePlaceholder, "profiles": []string{"git-read"}}}}},
	}
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
	policy := registry["repositories"].([]any)[0].(map[string]any)["namespaces"].([]any)[0].(map[string]any)
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
	writeRegistry()
	if _, err := runner.loadDevelopmentRepositoryInputs("none"); err == nil {
		t.Fatal("generic Git transport unexpectedly accepted")
	}
	policy["transport"], policy["profiles"], policy["pushRefAllowlist"] = "git-only", []string{"git-write"}, []string{"refs/heads/review/skipper"}
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
