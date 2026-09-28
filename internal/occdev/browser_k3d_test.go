package occdev

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDevelopmentBrowserCertificateLimitsInstallationAndAgentHosts(t *testing.T) {
	directory := t.TempDir()
	console, agentDomain, cookieDomain := developmentBrowserHosts("occ-dev-example")
	if cookieDomain != "occ-dev-example.oce.localhost" {
		t.Fatalf("unexpected cookie domain %q", cookieDomain)
	}
	if err := writeDevelopmentTLS(directory, "browser", "OCC development browser CA", []string{console, "*." + agentDomain}); err != nil {
		t.Fatal(err)
	}
	ca, err := os.ReadFile(filepath.Join(directory, "browser-ca.crt"))
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := os.ReadFile(filepath.Join(directory, "browser-tls.crt"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		t.Fatal("browser CA is invalid")
	}
	block, _ := pem.Decode(certificate)
	if block == nil {
		t.Fatal("browser certificate is invalid")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{console, "agent-123." + agentDomain} {
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: host}); err != nil {
			t.Fatalf("expected host %q did not verify: %v", host, err)
		}
	}
	// A different installation or sibling host must never share this TLS identity.
	for _, host := range []string{"console.occ-dev-other.oce.localhost", "other." + cookieDomain, "nested.agent-123." + agentDomain} {
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: host}); err == nil {
			t.Fatalf("unexpected browser host %q verified", host)
		}
	}
	for _, name := range []string{"browser-ca.key", "browser-tls.key"} {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("browser key %s is not private", name)
		}
	}
}

func TestBrowserHTTPRejectsUnsupportedProfilesBeforeProvisioning(t *testing.T) {
	for _, scenario := range []struct {
		name, scheme, controlPlane, sandbox string
	}{
		{"invalid scheme", "ftp", "kubernetes", "none"},
		{"compose", "http", "compose", "none"},
		{"openshell", "http", "kubernetes", "openshell"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			t.Setenv("OCC_DEVELOPMENT_BROWSER_SCHEME", scenario.scheme)
			t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", scenario.controlPlane)
			t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", scenario.sandbox)
			err := Up(context.Background(), Options{Repository: t.TempDir()})
			if err == nil || !strings.Contains(err.Error(), "OCC_DEVELOPMENT_BROWSER_SCHEME") {
				t.Fatalf("unsupported browser mode was not rejected: %v", err)
			}
		})
	}
}
