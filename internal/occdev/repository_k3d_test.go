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
	for _, name := range []string{"repository-ca.key", "repository-tls.key"} {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatalf("%s is not private", name)
		}
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
}
