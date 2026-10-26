package occdev

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

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
	for _, endpoint := range []string{
		"openshell-gateway.example.com:8443",
		"ftp://openshell-gateway.example.com",
		"https://" + url.UserPassword("user", "pass").String() + "@openshell-gateway.example.com",
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
	if len(egress) != 1 ||
		!reflect.DeepEqual(egress[0]["to"], []any{map[string]any{"ipBlock": map[string]any{"cidr": "203.0.113.10/32"}}}) ||
		!reflect.DeepEqual(egress[0]["ports"], []any{map[string]any{"protocol": "TCP", "port": float64(8443)}}) {
		t.Fatalf("unexpected external egress: %#v", egress)
	}
}
