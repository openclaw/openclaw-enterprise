package occdev

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

func externalTestState(t *testing.T) *developmentState {
	t.Helper()
	repository, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return &developmentState{
		Version:           3,
		Repository:        repository,
		ComputeDriver:     "kubernetes",
		SandboxDriver:     "openshell",
		DeploymentMode:    "k3d",
		PlatformNamespace: "oce-system",
		APIPort:           3000,
		BrowserPort:       8443,
		Cluster:           "occ-dev-external",
		directory:         t.TempDir(),
		openShellExternal: &externalOpenShell{
			endpoint:         "https://openshell-gateway.example.com:8443",
			oidcTokenURL:     "https://idp.example.com/realms/openshell/protocol/openid-connect/token",
			oidcClientID:     "occ-openshell",
			clientSecretPath: "/state/openshell-client-secret",
			addresses:        []string{"203.0.113.10/32"},
			port:             8443,
			tokenAddresses:   []string{"198.51.100.20/32"},
			tokenPort:        443,
			caPath:           "/state/openshell-ca.crt",
		},
	}
}

func TestReadExternalOpenShellSelection(t *testing.T) {
	if external, err := readExternalOpenShell(map[string]string{}); external != nil || err != nil {
		t.Fatalf("an empty selection must keep the profile gateway: %v %v", external, err)
	}
	secret := filepath.Join(t.TempDir(), "client-secret")
	if err := os.WriteFile(secret, []byte("test-secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	complete := map[string]string{
		"OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT":        "https://openshell-gateway.example.com:8443",
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL":          "https://idp.example.com/token",
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_ID":          "occ-openshell",
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE": secret,
	}
	for name := range complete {
		partial := map[string]string{}
		for key, value := range complete {
			if key != name {
				partial[key] = value
			}
		}
		if _, err := readExternalOpenShell(partial); err == nil {
			t.Fatalf("removing %s must reject the selection", name)
		}
	}
	// The OIDC selection is meaningless without an external gateway and is rejected.
	oidcOnly := map[string]string{"OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_ID": "occ-openshell"}
	if _, err := readExternalOpenShell(oidcOnly); err == nil {
		t.Fatal("OIDC variables without an endpoint must be rejected")
	}
	// The token URL follows the Backend parser's rule: https without credentials,
	// query, or fragment, or cleartext to a numeric loopback address only.
	for _, tokenURL := range []string{
		"http://idp.example.com/token",
		"https://user:pass@idp.example.com/token",
		"https://idp.example.com/token?audience=x",
		"ftp://idp.example.com/token",
		"idp.example.com/token",
	} {
		invalid := map[string]string{}
		for key, value := range complete {
			invalid[key] = value
		}
		invalid["OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL"] = tokenURL
		if _, err := readExternalOpenShell(invalid); err == nil {
			t.Fatalf("token URL %q must be rejected", tokenURL)
		}
	}
	// Cleartext is permitted only to a numeric loopback address.
	loopback := map[string]string{}
	for key, value := range complete {
		loopback[key] = value
	}
	loopback["OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL"] = "http://127.0.0.1:8081/token"
	if external, err := readExternalOpenShell(loopback); err != nil || external == nil {
		t.Fatalf("a loopback token URL must be accepted: %v %v", external, err)
	}
	for _, endpoint := range []string{
		"openshell-gateway.example.com:8443",
		"ftp://openshell-gateway.example.com",
		"https://user:pass@openshell-gateway.example.com",
		"https://openshell-gateway.example.com/path",
		"https://openshell-gateway.example.com?query",
	} {
		invalid := map[string]string{}
		for key, value := range complete {
			invalid[key] = value
		}
		invalid["OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT"] = endpoint
		if _, err := readExternalOpenShell(invalid); err == nil {
			t.Fatalf("endpoint %q must be rejected", endpoint)
		}
	}
	external, err := readExternalOpenShell(complete)
	if err != nil {
		t.Fatal(err)
	}
	if external.endpoint != "https://openshell-gateway.example.com:8443" || external.oidcClientID != "occ-openshell" {
		t.Fatalf("unexpected external selection: %+v", external)
	}
	if external.caPath != "" {
		t.Fatal("no CA is selected, so the selection must keep system trust")
	}
	// The optional CA bundle is a PEM certificate bundle and requires the endpoint.
	caFile := filepath.Join(t.TempDir(), "openshell-ca.crt")
	if err := os.WriteFile(caFile, []byte("not a certificate"), 0600); err != nil {
		t.Fatal(err)
	}
	withInvalidCA := map[string]string{}
	for key, value := range complete {
		withInvalidCA[key] = value
	}
	withInvalidCA["OCC_DEVELOPMENT_OPENSHELL_CA_FILE"] = caFile
	if _, err := readExternalOpenShell(withInvalidCA); err == nil {
		t.Fatal("a non-PEM CA selection must be rejected")
	}
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: testCertificate(t)}), 0600); err != nil {
		t.Fatal(err)
	}
	withCA := map[string]string{}
	for key, value := range complete {
		withCA[key] = value
	}
	withCA["OCC_DEVELOPMENT_OPENSHELL_CA_FILE"] = caFile
	selected, err := readExternalOpenShell(withCA)
	if err != nil {
		t.Fatal(err)
	}
	if selected.caPath != caFile {
		t.Fatalf("the CA selection must be carried: %+v", selected)
	}
	caOnly := map[string]string{"OCC_DEVELOPMENT_OPENSHELL_CA_FILE": caFile}
	if _, err := readExternalOpenShell(caOnly); err == nil {
		t.Fatal("a CA selection without an endpoint must be rejected")
	}
}

// testCertificate returns a minimal self-signed certificate the selection accepts as a
// PEM bundle; the launcher only checks that the bundle parses, not who signed it.
func testCertificate(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		IsCA:                  true,
		BasicConstraintsValid: true,
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestOpenShellExternalAddressesTranslateIPLiteralEndpoints(t *testing.T) {
	cidrs, port, err := openShellExternalAddresses("https://203.0.113.10:8443")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cidrs, []string{"203.0.113.10/32"}) || port != 8443 {
		t.Fatalf("unexpected translation: %v %d", cidrs, port)
	}
	defaults, port, err := openShellExternalAddresses("https://203.0.113.10")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(defaults, cidrs) || port != 443 {
		t.Fatalf("unexpected default translation: %v %d", defaults, port)
	}
}

func TestExternalOpenShellInstallationAuthenticatesWithOidc(t *testing.T) {
	state := externalTestState(t)
	assets := &openShellDevelopmentAssets{workspaceResources: []any{map[string]any{
		"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]any{"name": "openshell-sandbox"},
	}}}
	if err := writeInstallation(state, "runtime@"+profileTestDigest, assets, "", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, required := range []string{
		"mode: oidcClientCredentials",
		"tokenUrl: https://idp.example.com/realms/openshell/protocol/openid-connect/token",
		"clientId: occ-openshell",
		"clientSecretPath: " + openShellClientSecretContainerPath,
		"endpoint: https://openshell-gateway.example.com:8443",
		"rootCertificatePath: " + openShellExternalCAKubernetesPath,
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("installation.yaml is missing %q", required)
		}
	}
	// The external connection is TLS with authentication, so the development-only
	// NetworkPolicy declaration must not appear.
	if strings.Contains(text, "insecureTransport") {
		t.Fatal("an external TLS gateway must not declare insecureTransport")
	}

	var installation struct {
		Backend []struct {
			Configuration struct {
				Auth map[string]any `yaml:"auth"`
			} `yaml:"configuration"`
		} `yaml:"backend"`
		Drivers struct {
			Sandbox struct {
				Configuration struct {
					Gateway struct {
						NetworkPolicyResources []struct {
							Spec struct {
								Egress []struct {
									To    []map[string]any `yaml:"to"`
									Ports []map[string]any `yaml:"ports"`
								} `yaml:"egress"`
							} `yaml:"spec"`
						} `yaml:"networkPolicyResources"`
					} `yaml:"gateway"`
				} `yaml:"configuration"`
			} `yaml:"sandbox"`
			Compute struct {
				Configuration struct {
					Network struct {
						ProviderHarness map[string]any `yaml:"providerHarness"`
					} `yaml:"network"`
				} `yaml:"configuration"`
			} `yaml:"compute"`
		} `yaml:"drivers"`
	}
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	if len(installation.Backend) != 1 || !reflect.DeepEqual(installation.Backend[0].Configuration.Auth, map[string]any{
		"mode":             "oidcClientCredentials",
		"tokenUrl":         "https://idp.example.com/realms/openshell/protocol/openid-connect/token",
		"clientId":         "occ-openshell",
		"clientSecretPath": openShellClientSecretContainerPath,
		"tokenAuth":        "client_secret_basic",
	}) {
		t.Fatalf("unexpected external Backend auth: %#v", installation.Backend)
	}
	// Supervisor callbacks target the translated external address, not Pod selection.
	callback := installation.Drivers.Sandbox.Configuration.Gateway.NetworkPolicyResources
	if len(callback) != 1 || len(callback[0].Spec.Egress) != 1 {
		t.Fatalf("unexpected callback policies: %#v", callback)
	}
	if !reflect.DeepEqual(callback[0].Spec.Egress[0].To, []map[string]any{{"ipBlock": map[string]any{"cidr": "203.0.113.10/32"}}}) {
		t.Fatalf("unexpected callback egress targets: %#v", callback[0].Spec.Egress[0].To)
	}
	if !reflect.DeepEqual(callback[0].Spec.Egress[0].Ports, []map[string]any{{"protocol": "TCP", "port": 8443}}) {
		t.Fatalf("unexpected callback egress ports: %#v", callback[0].Spec.Egress[0].Ports)
	}
	// The ClusterIP bridge is only for the owned in-cluster gateway.
	if len(installation.Drivers.Compute.Configuration.Network.ProviderHarness) != 0 {
		t.Fatalf("an external gateway must not configure the provider Harness bridge: %#v", installation.Drivers.Compute.Configuration.Network.ProviderHarness)
	}
}

func TestExternalOpenShellNetworkPoliciesAdmitOnlyTheTranslatedAddress(t *testing.T) {
	state := externalTestState(t)
	policies := developmentOpenShellNetworkPolicies(state, state.PlatformNamespace, map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"})
	items := jsonValue(t, policies).(map[string]any)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("an external gateway has no in-cluster ingress policy: %#v", items)
	}
	encoded, err := json.Marshal(items[0])
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Spec struct {
			Egress []struct {
				To    []map[string]any `json:"to"`
				Ports []map[string]any `json:"ports"`
			} `json:"egress"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(encoded, &policy); err != nil {
		t.Fatal(err)
	}
	if policy.Metadata.Name != "openclaw-enterprise-openshell-egress" {
		t.Fatalf("unexpected policy: %s", policy.Metadata.Name)
	}
	// The JSON round trip types the port as a number; compare the normalized value.
	normalized, err := json.Marshal(policy.Spec.Egress)
	if err != nil {
		t.Fatal(err)
	}
	var egress []map[string]any
	if err := json.Unmarshal(normalized, &egress); err != nil {
		t.Fatal(err)
	}
	// The API and worker reach both the gateway and the issuer that mints their
	// client-credentials token; each keeps its own translated address and port.
	if len(egress) != 2 {
		t.Fatalf("unexpected external egress: %#v", egress)
	}
	if !reflect.DeepEqual(egress[0]["to"], []any{map[string]any{"ipBlock": map[string]any{"cidr": "203.0.113.10/32"}}}) ||
		!reflect.DeepEqual(egress[0]["ports"], []any{map[string]any{"protocol": "TCP", "port": float64(8443)}}) {
		t.Fatalf("unexpected gateway egress: %#v", egress[0])
	}
	if !reflect.DeepEqual(egress[1]["to"], []any{map[string]any{"ipBlock": map[string]any{"cidr": "198.51.100.20/32"}}}) ||
		!reflect.DeepEqual(egress[1]["ports"], []any{map[string]any{"protocol": "TCP", "port": float64(443)}}) {
		t.Fatalf("unexpected token endpoint egress: %#v", egress[1])
	}
}

func TestSelectExternalOpenShellRefusesTheProtectedProfile(t *testing.T) {
	env := map[string]string{}
	// The protected profile pins its own mTLS-authenticated gateway; selecting an
	// external one beside it must fail before any cluster effect.
	if external, err := selectExternalOpenShell(env, true); external != nil || err != nil {
		t.Fatalf("an empty selection stays valid under protected egress: %v %v", external, err)
	}
	secret := filepath.Join(t.TempDir(), "client-secret")
	if err := os.WriteFile(secret, []byte("test-secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env = map[string]string{
		"OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT":        "https://openshell-gateway.example.com:8443",
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL":          "https://idp.example.com/token",
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_ID":          "occ-openshell",
		"OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE": secret,
	}
	if _, err := selectExternalOpenShell(env, true); err == nil || !strings.Contains(err.Error(), "protected egress profile") {
		t.Fatalf("the protected profile must refuse an external gateway: %v", err)
	}
}
