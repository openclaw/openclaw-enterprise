package occdev

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
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
	info, err := os.Stat(filepath.Join(directory, "browser-tls.key"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("browser leaf key is not private")
	}
	// Nothing needs the CA key after the leaf is signed, so it never reaches disk.
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	var written []string
	for _, entry := range entries {
		written = append(written, entry.Name())
	}
	if !slices.Equal(written, []string{"browser-ca.crt", "browser-tls.crt", "browser-tls.key"}) {
		t.Fatalf("unexpected browser TLS files %v", written)
	}
}

// The CA developers trust in their browser can vouch only for this installation's
// console and Agent hosts, even when its key is used to sign another name.
func TestDevelopmentBrowserCAIsNameConstrainedToTheInstallation(t *testing.T) {
	console, agentDomain, _ := developmentBrowserHosts("occ-dev-example")
	files, caKey, err := generateDevelopmentTLS("browser", "OCC development browser CA", []string{console, "*." + agentDomain})
	if err != nil {
		t.Fatal(err)
	}
	ca := parseDevelopmentCertificate(t, files["browser-ca.crt"])
	if !slices.Equal(ca.PermittedDNSDomains, []string{console, agentDomain}) || !ca.PermittedDNSDomainsCritical {
		t.Fatalf("browser CA name constraints = %v (critical %v)", ca.PermittedDNSDomains, ca.PermittedDNSDomainsCritical)
	}
	if !ca.IsCA || !ca.MaxPathLenZero || ca.NotAfter.After(time.Now().AddDate(0, 3, 1)) {
		t.Fatalf("browser CA basic constraints or lifetime are too broad: isCA=%v maxPathLenZero=%v notAfter=%v", ca.IsCA, ca.MaxPathLenZero, ca.NotAfter)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	leaf := parseDevelopmentCertificate(t, files["browser-tls.crt"])
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: console}); err != nil {
		t.Fatalf("browser leaf did not verify under its CA: %v", err)
	}

	// Sign leaves for names outside the permitted subtrees with the same CA key.
	for _, host := range []string{"example.com", "console.occ-dev-other.oce.localhost", "other.occ-dev-example.oce.localhost"} {
		leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		template := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{host}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, template, ca, &leafKey.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		outside, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		_, err = outside.Verify(x509.VerifyOptions{Roots: roots, DNSName: host})
		var invalid x509.CertificateInvalidError
		if !errors.As(err, &invalid) || invalid.Reason != x509.CANotAuthorizedForThisName {
			t.Fatalf("browser CA vouched for %q outside its name constraints: %v", host, err)
		}
	}
}

func parseDevelopmentCertificate(t *testing.T, data []byte) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(data)
	if block == nil {
		t.Fatal("certificate is not PEM")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}
