package occdev

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json/v2"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// OCC_DEVELOPMENT_CONNECTIONS=openshell prepares the Kubernetes-only OpenShell
// profile for Agent OAuth connections (RFC-0023). This file owns the gateway
// PKI, the TLS gateway values, the client Workspace, the runtime image with the
// development CA and gog, and the Installation and chart settings they need.
const (
	developmentConnectionsOpenShell = "openshell"

	// OpenShell Workspace names are at most 19 characters.
	developmentConnectionClientWorkspace = "oce-oauth-clients"
	developmentConnectionRefreshID       = "credential-refresh-openshell-development"
	// The OCC chart mounts this Secret at the path the Backend configuration names.
	developmentOpenShellTLSSecret = "openclaw-openshell-tls"
	developmentOpenShellTLSMount  = "/etc/openclaw/openshell-tls"
	developmentConnectionRuntime  = "openclaw-enterprise-runtime:connections"

	developmentGogVersion = "0.36.0"
	developmentGogPath    = "/usr/local/bin/gog"
)

// Checksums from the gogcli v0.36.0 release checksums.txt.
var developmentGogSHA256 = map[string]string{
	"amd64": "b290fcfe907789a1efb685a9336e2a6c7f9598c3c00aada8d6c437eebc86c891",
	"arm64": "f68e3c35c9364dea5a4e515d13a23ab30ded46401c90d89e2953dca395d7fe42",
}

// developmentConnections validates OCC_DEVELOPMENT_CONNECTIONS. Browser
// connections need the OpenShell Credential Gateway, operator TLS to its gateway
// and a loopback public origin that Google Desktop clients accept, so only the
// Kubernetes-only OpenShell profile supports them.
func developmentConnections(env map[string]string) (string, error) {
	value := env["OCC_DEVELOPMENT_CONNECTIONS"]
	switch value {
	case "":
		return "", nil
	case developmentConnectionsOpenShell:
	default:
		return "", fmt.Errorf("OCC_DEVELOPMENT_CONNECTIONS must be openshell or unset")
	}
	if env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "kubernetes" || env["OCC_DEVELOPMENT_CONTROL_PLANE"] != "kubernetes" || env["OCC_DEVELOPMENT_SANDBOX_DRIVER"] != "openshell" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_CONNECTIONS=openshell requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes, OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes, and OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell")
	}
	return value, nil
}

// CheckDevelopmentConnections refuses OCC_DEVELOPMENT_CONNECTIONS for the Docker
// Compute profile, whose startup script does not read it.
func CheckDevelopmentConnections(getenv func(string) string) error {
	env := map[string]string{}
	for _, key := range []string{"OCC_DEVELOPMENT_CONNECTIONS", "OCC_DEVELOPMENT_COMPUTE_DRIVER", "OCC_DEVELOPMENT_CONTROL_PLANE", "OCC_DEVELOPMENT_SANDBOX_DRIVER"} {
		env[key] = getenv(key)
	}
	_, err := developmentConnections(env)
	return err
}

// developmentOpenShellServerNames are the gateway certificate's DNS names. The
// Agent Gateway reaches a Codex sandbox through the gateway at
// <namespace>--<sandbox>.openshell.localhost, so the wildcard is required.
func developmentOpenShellServerNames(namespace string) []string {
	service := openShellGatewayService
	return []string{
		service,
		service + "." + namespace,
		service + "." + namespace + ".svc",
		service + "." + namespace + ".svc.cluster.local",
		"localhost",
		"openshell.localhost",
		"*.openshell.localhost",
	}
}

// generateDevelopmentOpenShellPKI returns PEM files for one name-constrained CA,
// the gateway server certificate, the sandbox client certificate, and the OCC
// operator client certificate. OpenShell grants gateway-wide administration to a
// verified client certificate with OU=operator.
func generateDevelopmentOpenShellPKI(serverNames []string) (map[string][]byte, error) {
	now := time.Now()
	notBefore, notAfter := now.Add(-5*time.Minute), now.AddDate(0, 3, 0)
	serial := func() (*big.Int, error) { return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)) }
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	caSerial, err := serial()
	if err != nil {
		return nil, err
	}
	ca := &x509.Certificate{
		SerialNumber:                caSerial,
		Subject:                     pkix.Name{CommonName: "OCC development OpenShell CA"},
		NotBefore:                   notBefore,
		NotAfter:                    notAfter,
		IsCA:                        true,
		BasicConstraintsValid:       true,
		MaxPathLenZero:              true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         developmentTLSPermittedDomains(serverNames),
	}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{"openshell-ca.crt": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})}
	leaves := []struct {
		name    string
		subject pkix.Name
		usage   []x509.ExtKeyUsage
		dns     []string
	}{
		{"openshell-server", pkix.Name{CommonName: openShellGatewayService}, []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, serverNames},
		{"openshell-client", pkix.Name{CommonName: "openshell-sandbox"}, []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, nil},
		{"openshell-operator", pkix.Name{CommonName: "oce-operator", OrganizationalUnit: []string{"operator"}}, []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, nil},
	}
	for _, leaf := range leaves {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		leafSerial, err := serial()
		if err != nil {
			return nil, err
		}
		template := &x509.Certificate{
			SerialNumber:          leafSerial,
			Subject:               leaf.subject,
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			KeyUsage:              x509.KeyUsageDigitalSignature,
			ExtKeyUsage:           leaf.usage,
			DNSNames:              leaf.dns,
		}
		der, err := x509.CreateCertificate(rand.Reader, template, caCert, &key.PublicKey, caKey)
		if err != nil {
			return nil, err
		}
		keyDER, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, err
		}
		files[leaf.name+".crt"] = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		files[leaf.name+".key"] = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	}
	return files, nil
}

// prepareDevelopmentConnectionPKI writes the PKI to the state directory and
// applies the gateway's and OCC's TLS Secrets before either is installed.
func (r *runner) prepareDevelopmentConnectionPKI(ctx context.Context, state *developmentState) error {
	namespace := state.PlatformNamespace
	files, err := generateDevelopmentOpenShellPKI(developmentOpenShellServerNames(namespace))
	if err != nil {
		return err
	}
	for name, data := range files {
		if err := exclusiveWrite(filepath.Join(state.directory, name), data, 0600); err != nil {
			return err
		}
	}
	if err := r.ensureKubernetesNamespace(ctx, namespace); err != nil {
		return err
	}
	labels := map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}
	ca := string(files["openshell-ca.crt"])
	secret := func(name, kind string, data map[string]string) any {
		return map[string]any{"apiVersion": "v1", "kind": "Secret", "type": kind, "metadata": kubernetesMetadata(name, namespace, labels), "stringData": data}
	}
	// Names and keys are the OpenShell chart's defaults with its PKI Job disabled.
	secrets := map[string]any{"apiVersion": "v1", "kind": "List", "items": []any{
		secret("openshell-server-tls", "kubernetes.io/tls", map[string]string{"tls.crt": string(files["openshell-server.crt"]), "tls.key": string(files["openshell-server.key"]), "ca.crt": ca}),
		secret("openshell-client-tls", "kubernetes.io/tls", map[string]string{"tls.crt": string(files["openshell-client.crt"]), "tls.key": string(files["openshell-client.key"]), "ca.crt": ca}),
		secret("openshell-server-client-ca", "Opaque", map[string]string{"ca.crt": ca}),
		secret(developmentOpenShellTLSSecret, "Opaque", map[string]string{"ca.crt": ca, "operator.crt": string(files["openshell-operator.crt"]), "operator.key": string(files["openshell-operator.key"])}),
	}}
	return r.writeAndApply(ctx, state, "openshell-tls", secrets)
}

// openShellGatewayTLSValues replaces the plain HTTP gateway with HTTPS that
// verifies client certificates and grants OU=operator administration. Sandboxes
// still authenticate with gateway-minted JWTs.
func openShellGatewayTLSValues() []string {
	return []string{
		"--set=server.disableTls=false",
		"--set=server.tls.enableMtls=true",
		// The chart refuses a nested openshell.gateway map beside its dotted keys.
		`--set-json=gatewayConfig={"openshell.gateway.mtls_auth":{"operator_enabled":true}}`,
	}
}

// buildDevelopmentConnectionRuntime derives the runtime image with the
// development CA in the system store, which the Agent Gateway uses for the HTTPS
// gateway, and a checksum-verified gog for the Gmail connection.
func (r *runner) buildDevelopmentConnectionRuntime(ctx context.Context, state *developmentState, base string) (string, error) {
	config, err := r.output(ctx, r.engine, "image", "inspect", "--format", "{{.Architecture}} {{.Config.User}}", base)
	if err != nil {
		return "", err
	}
	architecture, user, _ := strings.Cut(strings.TrimSpace(string(config)), " ")
	expected, ok := developmentGogSHA256[architecture]
	if !ok {
		return "", fmt.Errorf("gog %s has no pinned build for runtime architecture %q", developmentGogVersion, architecture)
	}
	if user == "" {
		user = "root"
	}
	buildContext := filepath.Join(state.directory, "connections-runtime")
	if err := os.Mkdir(buildContext, 0700); err != nil {
		return "", err
	}
	archive := filepath.Join(state.directory, "gog.tar.gz")
	url := fmt.Sprintf("https://github.com/openclaw/gogcli/releases/download/v%[1]s/gogcli_%[1]s_linux_%[2]s.tar.gz", developmentGogVersion, architecture)
	if err := downloadVerified(ctx, url, archive, expected); err != nil {
		return "", err
	}
	if err := extractArchiveFile(archive, "gog", filepath.Join(buildContext, "gog")); err != nil {
		return "", err
	}
	ca, err := os.ReadFile(filepath.Join(state.directory, "openshell-ca.crt"))
	if err != nil {
		return "", err
	}
	if err := exclusiveWrite(filepath.Join(buildContext, "openshell-ca.crt"), ca, 0644); err != nil {
		return "", err
	}
	dockerfile := fmt.Sprintf(`FROM %s
USER root
COPY openshell-ca.crt /usr/local/share/ca-certificates/occ-development-openshell-ca.crt
COPY --chmod=0755 gog %s
RUN update-ca-certificates
ENV NODE_USE_SYSTEM_CA=1
USER %s
`, base, developmentGogPath, user)
	if err := exclusiveWrite(filepath.Join(buildContext, "Dockerfile"), []byte(dockerfile), 0600); err != nil {
		return "", err
	}
	if err := r.run(ctx, r.engine, "build", "--tag", developmentConnectionRuntime, buildContext); err != nil {
		return "", err
	}
	return developmentConnectionRuntime, nil
}

// extractArchiveFile writes the one regular file named name from a gzip tar.
func extractArchiveFile(archive, name, destination string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return fmt.Errorf("%s does not contain %s", filepath.Base(archive), name)
		}
		if err != nil {
			return err
		}
		if path.Clean(header.Name) != name {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return fmt.Errorf("%s entry %s is not a regular file", filepath.Base(archive), name)
		}
		output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(output, reader)
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
}

// developmentConnectionBackend adds HTTPS and the operator client certificate,
// which credential retrieval from the client Workspace requires. The gateway
// still admits callers without bearer tokens, so network policy remains the
// boundary for ordinary RPCs.
func developmentConnectionBackend(backend map[string]any) {
	configuration := backend["configuration"].(map[string]any)
	configuration["endpoint"] = strings.Replace(configuration["endpoint"].(string), "http://", "https://", 1)
	configuration["rootCertificatePath"] = developmentOpenShellTLSMount + "/ca.crt"
	configuration["operatorTls"] = map[string]any{
		"certificatePath": developmentOpenShellTLSMount + "/operator.crt",
		"privateKeyPath":  developmentOpenShellTLSMount + "/operator.key",
	}
	backend["drivers"].(map[string]string)["credential_refresh"] = developmentConnectionRefreshID
}

// developmentConnectionDrivers selects the Credential Refresh Driver with the
// client Workspace and lets gog receive connection credentials.
func developmentConnectionDrivers(drivers map[string]any) {
	drivers["credential_refresh"] = map[string]any{
		"id":            developmentConnectionRefreshID,
		"configuration": map[string]any{"clientWorkspace": developmentConnectionClientWorkspace},
	}
	gateway := drivers["credential_gateway"].(map[string]any)["configuration"].(map[string]any)
	gateway["toolBinaries"] = []string{developmentGogPath}
}

// developmentConnectionChartValues mounts the OCC side of the PKI and opens API
// egress for the callback's code exchange with template token URLs.
func developmentConnectionChartValues(values map[string]any) {
	values["backend"] = map[string]any{"openshell": map[string]any{"tls": map[string]any{"secretName": developmentOpenShellTLSSecret, "mountPath": developmentOpenShellTLSMount}}}
	values["agentConnections"] = map[string]any{"tokenEgress": map[string]any{"enabled": true}}
}

// provisionDevelopmentClientWorkspace creates the operator-provisioned
// Workspace that holds OAuth client secrets. OpenShell's operator mode backs
// each Workspace with a labeled Kubernetes namespace and the Workspace chart's
// RBAC. The gateway image ships no CLI, so the API Pod, which already holds the
// operator certificate and may reach the gateway, creates the Workspace with
// OCC's own gRPC client.
func (r *runner) provisionDevelopmentClientWorkspace(ctx context.Context, state *developmentState, assets *openShellDevelopmentAssets, timeout time.Duration) error {
	namespace := developmentConnectionClientWorkspace
	if err := r.ensureKubernetesNamespace(ctx, namespace); err != nil {
		return err
	}
	if err := r.run(ctx, "kubectl", "label", "namespace", namespace, "--overwrite", openShellOperatorNamespaceLabel+"="+openShellOperatorNamespaceValue); err != nil {
		return err
	}
	items := make([]any, 0, len(assets.workspaceResources))
	for _, resource := range assets.workspaceResources {
		data, err := json.Marshal(resource)
		if err != nil {
			return err
		}
		var copied map[string]any
		if err := json.Unmarshal(data, &copied); err != nil {
			return err
		}
		metadata, ok := copied["metadata"].(map[string]any)
		if !ok {
			return fmt.Errorf("OpenShell workspace chart rendered a resource without metadata")
		}
		metadata["namespace"] = namespace
		items = append(items, copied)
	}
	if err := r.writeAndApply(ctx, state, "client-workspace-resources", map[string]any{"apiVersion": "v1", "kind": "List", "items": items}); err != nil {
		return err
	}
	input, err := json.Marshal(map[string]any{
		"endpoint":    fmt.Sprintf("https://%s.%s.svc.cluster.local:8080", openShellGatewayService, state.PlatformNamespace),
		"ca":          developmentOpenShellTLSMount + "/ca.crt",
		"certificate": developmentOpenShellTLSMount + "/operator.crt",
		"key":         developmentOpenShellTLSMount + "/operator.key",
		"name":        developmentConnectionClientWorkspace,
		"timeoutMs":   timeout.Milliseconds(),
	})
	if err != nil {
		return err
	}
	script := fmt.Sprintf(`const input = %s;
const { GrpcOpenShellGatewayClient } = await import("/app/apps/controller/src/drivers/sandbox/openshell-gateway-client.ts");
const client = new GrpcOpenShellGatewayClient({ endpoint: input.endpoint, rootCertificatePath: input.ca, requestTimeoutMs: 30000, auth: { mode: "mutualTls", certificatePath: input.certificate, privateKeyPath: input.key } });
try {
  const signal = AbortSignal.timeout(input.timeoutMs);
  const workspace = (await client.getWorkspace(input.name, signal)) ?? (await client.createWorkspace(input.name, { "openclaw.dev/purpose": "oauth-client-secrets" }, signal));
  if (workspace.phase !== "WORKSPACE_PHASE_ACTIVE" && workspace.phase !== 1) {
    throw new Error("OpenShell Workspace " + input.name + " is not active.");
  }
} finally {
  client.close();
}
`, input)
	command := r.command(ctx, "kubectl", "exec", "-i", "--namespace", state.PlatformNamespace, "deploy/openclaw-enterprise-api", "-c", "api", "--", "node", "--input-type=module", "-")
	command.Stdin = strings.NewReader(script)
	command.Stdout, command.Stderr = r.opts.Out, r.opts.Err
	if err := command.Run(); err != nil {
		return fmt.Errorf("create the OpenShell client Workspace %s: %w", developmentConnectionClientWorkspace, err)
	}
	return nil
}

// developmentConnectionInstructions prints the callback derived from the
// console origin: loopback HTTP, which Google Desktop clients accept, or the
// HTTPS console under OCC_DEVELOPMENT_BROWSER_DOMAIN for Web clients.
func developmentConnectionInstructions(state *developmentState) string {
	origin := fmt.Sprintf("http://127.0.0.1:%d", state.APIPort)
	if state.BrowserPort != 0 {
		console, _, _ := state.browserHosts()
		origin = developmentBrowserOrigin(console, state.BrowserPort)
	}
	return fmt.Sprintf(`Agent OAuth connections: enabled
  Callback URI: %s/oauth/callback
  Client Workspace: %s
  Connection tool: %s (gog %s)
  Setup: docs/guides/deploy/local-agent-connections.md
`, origin, developmentConnectionClientWorkspace, developmentGogPath, developmentGogVersion)
}
