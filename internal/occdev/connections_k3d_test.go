package occdev

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/x509"
	"encoding/pem"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

func connectionsProfileEnv() map[string]string {
	return map[string]string{
		"OCC_DEVELOPMENT_CONNECTIONS":    "openshell",
		"OCC_DEVELOPMENT_COMPUTE_DRIVER": "kubernetes",
		"OCC_DEVELOPMENT_CONTROL_PLANE":  "kubernetes",
		"OCC_DEVELOPMENT_SANDBOX_DRIVER": "openshell",
	}
}

func TestDevelopmentConnectionsAcceptsOnlyTheKubernetesOnlyOpenShellProfile(t *testing.T) {
	if value, err := developmentConnections(connectionsProfileEnv()); err != nil || value != "openshell" {
		t.Fatalf("developmentConnections = %q, %v", value, err)
	}
	if value, err := developmentConnections(map[string]string{}); err != nil || value != "" {
		t.Fatalf("unset: developmentConnections = %q, %v", value, err)
	}
	cases := map[string]struct{ key, value, want string }{
		"docker compute":  {"OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker", "OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes"},
		"compose plane":   {"OCC_DEVELOPMENT_CONTROL_PLANE", "compose", "OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes"},
		"no sandbox":      {"OCC_DEVELOPMENT_SANDBOX_DRIVER", "none", "OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell"},
		"unset sandbox":   {"OCC_DEVELOPMENT_SANDBOX_DRIVER", "", "OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell"},
		"unknown variant": {"OCC_DEVELOPMENT_CONNECTIONS", "google", "must be openshell or unset"},
	}
	for name, test := range cases {
		env := connectionsProfileEnv()
		env[test.key] = test.value
		if _, err := developmentConnections(env); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v does not mention %q", name, err, test.want)
		}
	}
}

func TestDockerComputeStartupRefusesConnections(t *testing.T) {
	env := map[string]string{"OCC_DEVELOPMENT_CONNECTIONS": "openshell"}
	if err := CheckDevelopmentConnections(func(key string) string { return env[key] }); err == nil {
		t.Fatal("the Docker Compute profile accepted OCC_DEVELOPMENT_CONNECTIONS=openshell")
	}
	if err := CheckDevelopmentConnections(func(string) string { return "" }); err != nil {
		t.Fatalf("unset connections were refused: %v", err)
	}
}

func TestUpRefusesConnectionsWithTheComposeControlPlane(t *testing.T) {
	for key, value := range connectionsProfileEnv() {
		t.Setenv(key, value)
	}
	t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", "compose")
	t.Setenv("PATH", t.TempDir()) // any external command would fail differently
	err := Up(context.Background(), Options{Repository: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "OCC_DEVELOPMENT_CONNECTIONS=openshell") {
		t.Fatalf("Up error = %v", err)
	}
}

func parseCertificate(t *testing.T, data []byte) *x509.Certificate {
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

func TestDevelopmentOpenShellPKIServesSandboxRoutesAndGrantsOnlyTheOperator(t *testing.T) {
	files, err := generateDevelopmentOpenShellPKI(developmentOpenShellServerNames("oce-system"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parseCertificate(t, files["openshell-ca.crt"]))
	server := parseCertificate(t, files["openshell-server.crt"])
	// OCC dials the Service; the Agent Gateway dials a Codex sandbox through the
	// gateway's sandbox route, which failed with HTTP 502 before the wildcard.
	for _, name := range []string{
		"openshell-gateway.oce-system.svc.cluster.local",
		"oce-21313def416a1b6--os-9d45c82a622c63f1.openshell.localhost",
	} {
		if _, err := server.Verify(x509.VerifyOptions{DNSName: name, Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
			t.Errorf("server certificate does not serve %s: %v", name, err)
		}
	}
	// OpenShell grants gateway-wide administration to OU=operator; the sandbox
	// client certificate must not carry it.
	operator := parseCertificate(t, files["openshell-operator.crt"])
	client := parseCertificate(t, files["openshell-client.crt"])
	for name, certificate := range map[string]*x509.Certificate{"operator": operator, "client": client} {
		if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
			t.Errorf("%s certificate is not a client certificate from the CA: %v", name, err)
		}
	}
	if !reflect.DeepEqual(operator.Subject.OrganizationalUnit, []string{"operator"}) || len(client.Subject.OrganizationalUnit) != 0 {
		t.Fatalf("unexpected OUs: operator %v, client %v", operator.Subject.OrganizationalUnit, client.Subject.OrganizationalUnit)
	}
}

func TestConnectionsInstallationUsesOperatorTLSRefreshAndGog(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	state.Connections = developmentConnectionsOpenShell
	assets := &openShellDevelopmentAssets{workspaceResources: []any{map[string]any{
		"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]any{"name": "openshell-sandbox"},
	}}}
	if err := writeInstallation(state, "runtime@"+profileTestDigest, assets, "10.43.0.50", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var installation struct {
		Backend []struct {
			Configuration map[string]any    `yaml:"configuration"`
			Drivers       map[string]string `yaml:"drivers"`
		} `yaml:"backend"`
		Drivers struct {
			CredentialRefresh struct {
				ID            string         `yaml:"id"`
				Configuration map[string]any `yaml:"configuration"`
			} `yaml:"credential_refresh"`
			CredentialGateway struct {
				Configuration struct {
					ToolBinaries []string `yaml:"toolBinaries"`
				} `yaml:"configuration"`
			} `yaml:"credential_gateway"`
		} `yaml:"drivers"`
	}
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	if len(installation.Backend) != 1 {
		t.Fatalf("unexpected Backends: %+v", installation.Backend)
	}
	backend := installation.Backend[0]
	// The paths are where the chart mounts developmentOpenShellTLSSecret.
	want := map[string]any{
		"endpoint":            "https://openshell-gateway.oce-system.svc.cluster.local:8080",
		"insecureTransport":   "network-policy",
		"requestTimeoutMs":    30000,
		"rootCertificatePath": "/etc/openclaw/openshell-tls/ca.crt",
		"operatorTls": map[string]any{
			"certificatePath": "/etc/openclaw/openshell-tls/operator.crt",
			"privateKeyPath":  "/etc/openclaw/openshell-tls/operator.key",
		},
	}
	if !reflect.DeepEqual(backend.Configuration, want) {
		t.Fatalf("unexpected Backend configuration: %#v", backend.Configuration)
	}
	refresh := installation.Drivers.CredentialRefresh
	if backend.Drivers["credential_refresh"] != refresh.ID || refresh.ID != developmentConnectionRefreshID ||
		!reflect.DeepEqual(refresh.Configuration, map[string]any{"clientWorkspace": "oce-oauth-clients"}) {
		t.Fatalf("unexpected Credential Refresh Driver: backend %v, driver %+v", backend.Drivers, refresh)
	}
	if !reflect.DeepEqual(installation.Drivers.CredentialGateway.Configuration.ToolBinaries, []string{"/usr/local/bin/gog"}) {
		t.Fatalf("unexpected tool binaries: %v", installation.Drivers.CredentialGateway.Configuration.ToolBinaries)
	}
}

func TestConnectionsGatewayServesTLSWithOperatorAuthentication(t *testing.T) {
	for _, connections := range []string{"", developmentConnectionsOpenShell} {
		state := kubernetesOnlyOpenShellState(t)
		state.Connections = connections
		commands := fakeProfileCommands(t, map[string]string{
			"kubectl": `"get namespace oce-system") ;;
"create secret generic openshell-gateway-jwt-keys "*) ;;
"apply -f "*) ;;`,
			"helm": `"upgrade --install openshell-gateway "*) ;;`,
		})
		if err := os.Mkdir(filepath.Join(state.directory, "openshell"), 0o700); err != nil {
			t.Fatal(err)
		}
		r := newRunner(Options{Repository: state.Repository})
		assets := &openShellDevelopmentAssets{
			gatewayChart:    "/charts/openshell",
			gatewayImage:    "docker.io/openclaw-development/openshell-gateway@" + profileTestDigest,
			sandboxImage:    "docker.io/openclaw-development/openshell-sandbox@" + profileTestDigest,
			supervisorImage: "docker.io/openclaw-development/openshell-supervisor@" + profileTestDigest,
		}
		if err := r.installOpenShellGateway(context.Background(), state, assets, "oce-system", time.Minute); err != nil {
			t.Fatal(err)
		}
		index := slices.IndexFunc(commands(), func(command string) bool {
			return strings.HasPrefix(command, "helm upgrade --install openshell-gateway ")
		})
		install := commands()[index]
		tls := []string{
			"--set=server.disableTls=false",
			"--set=server.tls.enableMtls=true",
			`--set-json=gatewayConfig={"openshell.gateway.mtls_auth":{"operator_enabled":true}}`,
		}
		for _, value := range tls {
			if strings.Contains(install, value) != (connections != "") {
				t.Errorf("connections %q: TLS value %q selected incorrectly: %s", connections, value, install)
			}
		}
		if strings.Contains(install, "--set=server.disableTls=true") != (connections == "") {
			t.Errorf("connections %q: unexpected plain HTTP selection: %s", connections, install)
		}
	}
}

func TestExtractArchiveFileFindsTheReleaseBinary(t *testing.T) {
	directory := t.TempDir()
	archive := filepath.Join(directory, "gog.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	compressed := gzip.NewWriter(file)
	writer := tar.NewWriter(compressed)
	// The gogcli release archive stores the binary as ./gog.
	for _, entry := range []struct {
		name string
		kind byte
		body string
	}{{"./", tar.TypeDir, ""}, {"./gog", tar.TypeReg, "binary"}} {
		if err := writer.WriteHeader(&tar.Header{Name: entry.name, Typeflag: entry.kind, Mode: 0o755, Size: int64(len(entry.body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, closer := range []interface{ Close() error }{writer, compressed, file} {
		if err := closer.Close(); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(directory, "gog")
	if err := extractArchiveFile(archive, "gog", destination); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(destination); err != nil || string(data) != "binary" {
		t.Fatalf("extracted %q, %v", data, err)
	}
	if err := extractArchiveFile(archive, "missing", filepath.Join(directory, "missing")); err == nil {
		t.Fatal("a missing entry was accepted")
	}
}

func TestDevelopmentBrowserDomainAcceptsOnlyTheKubernetesControlPlane(t *testing.T) {
	env := map[string]string{
		"OCC_DEVELOPMENT_BROWSER_DOMAIN": "localtest.me",
		"OCC_DEVELOPMENT_COMPUTE_DRIVER": "kubernetes",
		"OCC_DEVELOPMENT_CONTROL_PLANE":  "kubernetes",
	}
	if value, err := developmentBrowserDomain(env); err != nil || value != "localtest.me" {
		t.Fatalf("developmentBrowserDomain = %q, %v", value, err)
	}
	cases := map[string]struct{ key, value, want string }{
		"compose plane": {"OCC_DEVELOPMENT_CONTROL_PLANE", "compose", "only .localhost"},
		"docker":        {"OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker", "OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes"},
		"keycloak":      {"OCC_DEVELOPMENT_SIGN_IN", "keycloak", "OCC_DEVELOPMENT_SIGN_IN"},
		"single label":  {"OCC_DEVELOPMENT_BROWSER_DOMAIN", "localhost", "lowercase DNS domain"},
		"upper case":    {"OCC_DEVELOPMENT_BROWSER_DOMAIN", "LocalTest.me", "lowercase DNS domain"},
		"with a port":   {"OCC_DEVELOPMENT_BROWSER_DOMAIN", "localtest.me:8443", "lowercase DNS domain"},
	}
	for name, test := range cases {
		copied := maps.Clone(env)
		copied[test.key] = test.value
		if _, err := developmentBrowserDomain(copied); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v does not mention %q", name, err, test.want)
		}
	}
	docker := map[string]string{"OCC_DEVELOPMENT_BROWSER_DOMAIN": "localtest.me"}
	if err := CheckDevelopmentBrowserDomain(func(key string) string { return docker[key] }); err == nil {
		t.Fatal("the Docker Compute profile accepted OCC_DEVELOPMENT_BROWSER_DOMAIN")
	}
}

func TestDevelopmentBrowserDomainMustResolveToLoopback(t *testing.T) {
	// .localhost names resolve to loopback without DNS; .invalid names never resolve.
	loopback := &developmentState{Cluster: "occ-dev-owned", BrowserDomain: "oce.localhost"}
	if err := checkDevelopmentBrowserDomain(context.Background(), loopback); err != nil {
		t.Fatalf("loopback domain refused: %v", err)
	}
	missing := &developmentState{Cluster: "occ-dev-owned", BrowserDomain: "example.invalid"}
	if err := checkDevelopmentBrowserDomain(context.Background(), missing); err == nil {
		t.Fatal("an unresolvable browser domain was accepted")
	}
}
