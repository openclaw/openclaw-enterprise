package occdev

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// The container path where both control planes mount the OpenShell OIDC client secret.
const openShellClientSecretContainerPath = "/run/openclaw-development/openshell-client-secret"

// externalOpenShell is an operator-selected external OpenShell gateway connection
// with OIDC client-credentials authentication, replacing the profile's pinned
// in-cluster gateway.
type externalOpenShell struct {
	endpoint         string
	oidcTokenURL     string
	oidcClientID     string
	clientSecretPath string
	// addresses and port are the translated exact gateway targets, and
	// tokenAddresses and tokenPort the issuer's, resolved once per start for
	// NetworkPolicies, which cannot select hostnames.
	addresses      []string
	port           int
	tokenAddresses []string
	tokenPort      int
}

// resolve translates the endpoint and token endpoint hosts to exact addresses
// for NetworkPolicy egress rules, the same translation production egress
// configuration documents for its /32 endpoints.
func (e *externalOpenShell) resolve() error {
	addresses, port, err := openShellExternalAddresses(e.endpoint)
	if err != nil {
		return err
	}
	tokenAddresses, tokenPort, err := openShellExternalAddresses(e.oidcTokenURL)
	if err != nil {
		return fmt.Errorf("resolve the OpenShell OIDC token endpoint: %w", err)
	}
	e.addresses = addresses
	e.port = port
	e.tokenAddresses = tokenAddresses
	e.tokenPort = tokenPort
	return nil
}

// readExternalOpenShell reads the OCC_DEVELOPMENT_OPENSHELL_* selection. A nil result
// selects the profile's own pinned gateway; the OIDC variables are meaningless without
// an external endpoint and are rejected rather than ignored.
func readExternalOpenShell(env map[string]string) (*externalOpenShell, error) {
	endpoint := env["OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT"]
	oidc := map[string]string{
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL":          env["OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL"],
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_ID":          env["OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_ID"],
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE": env["OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE"],
	}
	if endpoint == "" {
		for name, value := range oidc {
			if value != "" {
				return nil, fmt.Errorf("%s requires OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT", name)
			}
		}
		return nil, nil
	}
	for name, value := range oidc {
		if value == "" {
			return nil, fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT requires %s", name)
		}
	}
	origin, err := openShellExternalEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	tokenURL, err := openShellOidcTokenURL(oidc["OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL"])
	if err != nil {
		return nil, err
	}
	secretPath := oidc["OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE"]
	if !filepath.IsAbs(secretPath) {
		return nil, fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE must be an absolute path")
	}
	secret, err := os.ReadFile(secretPath)
	if err != nil {
		return nil, fmt.Errorf("read OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE: %w", err)
	}
	if len(strings.TrimSpace(string(secret))) == 0 {
		return nil, fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE is empty")
	}
	return &externalOpenShell{
		endpoint:         origin,
		oidcTokenURL:     tokenURL,
		oidcClientID:     oidc["OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_ID"],
		clientSecretPath: secretPath,
	}, nil
}

// selectExternalOpenShell reads, validates, and resolves the external gateway
// selection for a start. The protected egress profile refuses the combination:
// it pins its own mTLS-authenticated in-cluster gateway, and its Helm values
// and egress authority cannot carry an OIDC-authenticated external connection.
func selectExternalOpenShell(env map[string]string, protectedEgress bool) (*externalOpenShell, error) {
	external, err := readExternalOpenShell(env)
	if err != nil {
		return nil, err
	}
	if external == nil {
		return nil, nil
	}
	if protectedEgress {
		return nil, fmt.Errorf("the protected egress profile cannot select an external OpenShell gateway; unset OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT or disable protected egress")
	}
	if err := external.resolve(); err != nil {
		return nil, err
	}
	return external, nil
}

// openShellOidcTokenURL applies the Backend parser's rule so a launcher
// selection cannot reach Installation startup before failing: https without
// credentials, query, or fragment, or cleartext to a numeric loopback address.
func openShellOidcTokenURL(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() {
		return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL must be an absolute URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL must not include credentials, a query, or a fragment")
	}
	loopback := parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme == "https" || (parsed.Scheme == "http" && loopback) {
		return parsed.String(), nil
	}
	return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL must be https, or http to a numeric loopback address")
}

// openShellExternalEndpoint accepts a Backend-compatible https origin without
// credentials, path, query, or fragment. The rendered Backend authenticates with
// OIDC, which the parser admits only over TLS, so cleartext endpoints are
// refused here instead of failing later at Installation startup.
func openShellExternalEndpoint(value string) (string, error) {
	if !strings.Contains(value, "://") {
		return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT must include an https scheme")
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT is invalid: %w", err)
	}
	if parsed.Scheme != "https" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT must use https")
	}
	if parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT must be an origin without credentials, path, query, or fragment")
	}
	return parsed.String(), nil
}

// openShellExternalAddresses resolves the external gateway endpoint to the exact
// addresses NetworkPolicies must admit.
func openShellExternalAddresses(endpoint string) ([]string, int, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, 0, err
	}
	host := parsed.Hostname()
	addresses, err := net.LookupIP(host)
	if err != nil {
		return nil, 0, fmt.Errorf("resolve external OpenShell gateway host %s: %w", host, err)
	}
	seen := make(map[string]bool, len(addresses))
	cidrs := make([]string, 0, len(addresses))
	for _, address := range addresses {
		if address.To4() == nil && address.To16() == nil {
			continue
		}
		cidr := address.String()
		if address.To4() == nil {
			cidr = address.String() + "/128"
		} else {
			cidr = address.String() + "/32"
		}
		if !seen[cidr] {
			seen[cidr] = true
			cidrs = append(cidrs, cidr)
		}
	}
	if len(cidrs) == 0 {
		return nil, 0, fmt.Errorf("external OpenShell gateway host %s resolved to no addresses", host)
	}
	port := parsed.Port()
	if port == "" {
		port = "443"
		if parsed.Scheme == "http" {
			port = "80"
		}
	}
	var number int
	if _, err := fmt.Sscanf(port, "%d", &number); err != nil || number < 1 || number > 65535 {
		return nil, 0, fmt.Errorf("external OpenShell gateway port %q is invalid", port)
	}
	return cidrs, number, nil
}
