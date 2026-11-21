// Package devtls issues certificates for disposable OCE development environments.
package devtls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"time"
)

// BrowserHosts returns the Console host, Agent domain, and shared cookie domain.
func BrowserHosts(cluster string) (console, agentDomain, cookieDomain string) {
	cookieDomain = cluster + ".oce.localhost"
	return "console." + cookieDomain, "agents." + cookieDomain, cookieDomain
}

// developmentTLSPermittedDomains names the DNS subtrees the CA may vouch for:
// the leaf's names, with a leading wildcard label removed.
func developmentTLSPermittedDomains(hostnames []string) []string {
	domains := make([]string, 0, len(hostnames))
	for _, hostname := range hostnames {
		domains = append(domains, strings.TrimPrefix(hostname, "*."))
	}
	return domains
}

// Generate returns the PEM files to write and, for tests only, the
// CA key. The CA is name-constrained to the leaf's DNS names and lives no
// longer than the leaf.
func Generate(prefix, subject string, hostnames []string) (map[string][]byte, *ecdsa.PrivateKey, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial := func() (*big.Int, error) { return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)) }
	caSerial, err := serial()
	if err != nil {
		return nil, nil, err
	}
	leafSerial, err := serial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	notBefore, notAfter := now.Add(-5*time.Minute), now.AddDate(0, 3, 0)
	ca := &x509.Certificate{
		SerialNumber:                caSerial,
		Subject:                     pkix.Name{CommonName: subject},
		NotBefore:                   notBefore,
		NotAfter:                    notAfter,
		IsCA:                        true,
		BasicConstraintsValid:       true,
		MaxPathLenZero:              true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         developmentTLSPermittedDomains(hostnames),
	}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	leaf := &x509.Certificate{SerialNumber: leafSerial, DNSNames: hostnames, NotBefore: notBefore, NotAfter: notAfter, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	leafPrivate, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		return nil, nil, err
	}
	return map[string][]byte{
		prefix + "-ca.crt":  pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		prefix + "-tls.crt": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		prefix + "-tls.key": pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: leafPrivate}),
	}, caKey, nil
}
