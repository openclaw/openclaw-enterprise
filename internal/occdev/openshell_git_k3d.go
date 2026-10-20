package occdev

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json/v2"
	"encoding/pem"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The OpenShell request-phase Git route (docs/reference/repository-credentials/openshell-git.md):
// the worker serves the `oce-prepared-git` supervisor middleware, and the stock
// OpenShell 0.1.4 Gateway registers it through static gatewayConfig.
const (
	openShellGitSelector               = "OCC_DEVELOPMENT_OPENSHELL_GIT"
	openShellGitFixtureNetworkSelector = "OCC_DEVELOPMENT_OPENSHELL_GIT_FIXTURE_NETWORK"
	openShellSupervisorCASelector      = "OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_CA_FILE"

	openShellGitRegistration    = "oce-prepared-git"
	openShellGitAudience        = "oce-prepared-git"
	openShellGitPort            = 8445
	openShellGitService         = "openclaw-enterprise-openshell-git"
	openShellGitTLSSecret       = "openshell-git-tls"
	openShellGitIssuerConfigMap = "openshell-gateway-public"
	openShellGitCAConfigMap     = "occ-openshell-git-ca"
	openShellGitCAMount         = "/etc/openshell/oce-git-ca"
	openShellGitPayload         = 4 * 1024 * 1024
	openShellGitTimeout         = "3s"
	openShellGitOrigin          = "https://github.com"
	openShellGitAPIOrigin       = "https://api.github.com"
	openShellGitDNSConfigMapKey = "occ-openshell-git.server"
)

// Engine network names Docker and Podman accept.
var engineNetworkName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// Paths the kernel prerequisite reads; tests replace them.
var (
	hostKernelReleasePath = "/proc/sys/kernel/osrelease"
	hostLSMPath           = "/sys/kernel/security/lsm"
)

// openShellGitSelection validates the route's selectors before any effect.
func (r *runner) openShellGitSelection(controlPlane, sandbox string, protected bool) (bool, error) {
	value := r.env[openShellGitSelector]
	if value != "" && value != "0" && value != "1" {
		return false, fmt.Errorf("%s must be 0 or 1", openShellGitSelector)
	}
	if value != "1" {
		for _, key := range []string{openShellGitFixtureNetworkSelector, openShellSupervisorCASelector} {
			if r.env[key] != "" {
				return false, fmt.Errorf("%s requires %s=1", key, openShellGitSelector)
			}
		}
		return false, nil
	}
	if controlPlane != "kubernetes" || sandbox != "openshell" {
		return false, fmt.Errorf("%s requires OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes and OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell", openShellGitSelector)
	}
	if protected {
		return false, fmt.Errorf("%s cannot be combined with OCC_DEVELOPMENT_PROTECTED_EGRESS=1: the route selects neither credential_proxy nor egressAuthority", openShellGitSelector)
	}
	if r.env["OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY"] == "" {
		return false, fmt.Errorf("%s requires OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY with the registry, GitHub App key and upstream endpoints", openShellGitSelector)
	}
	if r.env["OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN"] != "" {
		return false, fmt.Errorf("%s always reaches %s and %s; select a local origin with %s, not OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN", openShellGitSelector, openShellGitOrigin, openShellGitAPIOrigin, openShellGitFixtureNetworkSelector)
	}
	if network := r.env[openShellGitFixtureNetworkSelector]; network != "" && !engineNetworkName.MatchString(network) {
		return false, fmt.Errorf("%s must name a container engine network", openShellGitFixtureNetworkSelector)
	}
	if path := r.env[openShellSupervisorCASelector]; path != "" {
		if _, err := readDevelopmentCABundle(path); err != nil {
			return false, fmt.Errorf("%s: %w", openShellSupervisorCASelector, err)
		}
	}
	return true, nil
}

// readDevelopmentCABundle reads public PEM certificates an operator selected.
func readDevelopmentCABundle(path string) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, fmt.Errorf("the CA bundle must be an absolute canonical path")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return nil, fmt.Errorf("the CA bundle must be a regular file of at most 1 MiB")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := parseDevelopmentCABundle(data); err != nil {
		return nil, err
	}
	return data, nil
}

// parseDevelopmentCABundle accepts one or more PEM certificates and nothing else.
func parseDevelopmentCABundle(data []byte) error {
	rest, certificates := data, 0
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			return fmt.Errorf("the CA bundle may contain only certificates")
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return fmt.Errorf("the CA bundle contains an invalid certificate")
		}
		certificates++
	}
	if certificates == 0 || len(bytes.TrimSpace(rest)) != 0 {
		return fmt.Errorf("the CA bundle must contain only PEM certificates")
	}
	return nil
}

// checkOpenShellGitKernel fails before cluster creation when the engine's
// kernel cannot start OpenShell Sandboxes: the Driver requires Landlock ABI v3,
// which needs Linux 6.2 or newer.
func (r *runner) checkOpenShellGitKernel(ctx context.Context) error {
	format := "{{.KernelVersion}}"
	if r.engine == "podman" {
		format = "{{.Host.Kernel}}"
	}
	data, err := r.output(ctx, r.engine, "info", "--format", format)
	if err != nil {
		return fmt.Errorf("read the container engine's kernel version: %w", err)
	}
	release := string(data)
	if !kernelAtLeast(release, 6, 2) {
		return fmt.Errorf("OpenShell Sandboxes need Landlock ABI v3, Linux 6.2 or newer; the container engine runs kernel %q (the Ubuntu 22.04 GA 5.15 kernel fails Sandbox startup: use an HWE kernel)", release)
	}
	// A local engine shares this host's kernel. Confirm Landlock is an active
	// LSM when the host lets us read the list; a remote engine is checked by Sandbox startup.
	host, err := os.ReadFile(hostKernelReleasePath)
	if err != nil || strings.TrimSpace(string(host)) != release {
		return nil
	}
	lsm, err := os.ReadFile(hostLSMPath)
	if err != nil {
		return nil
	}
	active := strings.TrimSpace(string(lsm))
	if !slices.Contains(strings.Split(active, ","), "landlock") {
		return fmt.Errorf("OpenShell Sandboxes need the Landlock LSM; the kernel's active LSMs are %q (add landlock to the lsm= boot parameter)", active)
	}
	return nil
}

// kernelAtLeast compares the leading major.minor of a kernel release.
func kernelAtLeast(release string, major, minor int) bool {
	parts := strings.SplitN(release, ".", 3)
	if len(parts) < 2 {
		return false
	}
	number := func(s string) int {
		end := 0
		for end < len(s) && s[end] >= '0' && s[end] <= '9' {
			end++
		}
		n, err := strconv.Atoi(s[:end])
		if err != nil {
			return -1
		}
		return n
	}
	gotMajor, gotMinor := number(parts[0]), number(parts[1])
	if gotMajor < 0 || gotMinor < 0 {
		return false
	}
	return gotMajor > major || (gotMajor == major && gotMinor >= minor)
}

// openShellBlocksAddress mirrors OpenShell 0.1.4's sandbox SSRF classification
// (crates/openshell-core/src/net.rs is_internal_ip plus the always-blocked
// ranges). A fixture behind such an address is unreachable from a Sandbox.
func openShellBlocksAddress(address netip.Addr) bool {
	if !address.Is4() {
		return true
	}
	if address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() || address.IsUnspecified() || address.IsMulticast() {
		return true
	}
	for _, prefix := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4"} {
		if netip.MustParsePrefix(prefix).Contains(address) {
			return true
		}
	}
	return false
}

// openShellGitFixtureAddress returns the single upstream endpoint a selected
// fixture network answers on as github.com and api.github.com.
func openShellGitFixtureAddress(cidrs []string) (netip.Addr, error) {
	if len(cidrs) != 1 {
		return netip.Addr{}, fmt.Errorf("%s requires exactly one upstream /32: the fixture address", openShellGitFixtureNetworkSelector)
	}
	prefix, err := netip.ParsePrefix(cidrs[0])
	if err != nil {
		return netip.Addr{}, err
	}
	if openShellBlocksAddress(prefix.Addr()) {
		return netip.Addr{}, fmt.Errorf("fixture address %s is in a range OpenShell Sandboxes refuse to reach (private, loopback, link-local, CGNAT, documentation or benchmarking); give the fixture network an address outside them", prefix.Addr())
	}
	return prefix.Addr(), nil
}

// checkOpenShellGitFixture confirms the selected network exists and contains
// the fixture address before the cluster is created.
func (r *runner) checkOpenShellGitFixture(ctx context.Context, inputs *developmentRepositoryInputs) error {
	network := r.env[openShellGitFixtureNetworkSelector]
	if network == "" {
		return nil
	}
	// The node keeps the k3d network as its default route only through
	// Docker's per-network gateway priority.
	if r.engine != "docker" {
		return fmt.Errorf("%s requires the Docker engine", openShellGitFixtureNetworkSelector)
	}
	address, err := openShellGitFixtureAddress(inputs.upstreamCIDRs)
	if err != nil {
		return err
	}
	// A synthetic origin's certificate chains to a private CA: the worker and
	// the supervisor must both trust it, or every Git request fails at runtime.
	if len(inputs.issuerCA) == 0 || r.env[openShellSupervisorCASelector] == "" {
		return fmt.Errorf("%s requires the origin's CA as issuer-ca.crt in the repository inputs and in %s", openShellGitFixtureNetworkSelector, openShellSupervisorCASelector)
	}
	version, err := r.output(ctx, r.engine, "version", "--format", "{{.Server.APIVersion}}")
	if err != nil {
		return fmt.Errorf("read the Docker Engine API version: %w", err)
	}
	if !dockerAPIAtLeast(strings.TrimSpace(string(version)), 1, 48) {
		return fmt.Errorf("%s requires Docker Engine 28 or newer (API 1.48) for network gateway priority; the engine reports API %q", openShellGitFixtureNetworkSelector, strings.TrimSpace(string(version)))
	}
	data, err := r.output(ctx, r.engine, "network", "inspect", network)
	if err != nil {
		return fmt.Errorf("fixture network %s is unavailable: %w", network, err)
	}
	var networks []struct {
		IPAM struct {
			Config []struct {
				Subnet string `json:"Subnet"`
			} `json:"Config"`
		} `json:"IPAM"`
	}
	if err := json.Unmarshal(data, &networks); err != nil || len(networks) != 1 {
		return fmt.Errorf("invalid fixture network information")
	}
	for _, entry := range networks[0].IPAM.Config {
		if prefix, err := netip.ParsePrefix(entry.Subnet); err == nil && prefix.Contains(address) {
			return nil
		}
	}
	return fmt.Errorf("fixture network %s does not contain the fixture address %s", network, address)
}

// dockerAPIAtLeast compares a Docker Engine API version such as "1.48".
func dockerAPIAtLeast(version string, major, minor int) bool {
	parts := strings.Split(version, ".")
	if len(parts) != 2 {
		return false
	}
	gotMajor, err1 := strconv.Atoi(parts[0])
	gotMinor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return false
	}
	return gotMajor > major || (gotMajor == major && gotMinor >= minor)
}

// attachOpenShellGitFixture puts the node on the fixture network and pins the
// GitHub hosts to the fixture in cluster DNS. Both the worker and the
// OpenShell supervisors resolve them there.
func (r *runner) attachOpenShellGitFixture(ctx context.Context, state *developmentState, inputs *developmentRepositoryInputs, timeout time.Duration) error {
	network := r.env[openShellGitFixtureNetworkSelector]
	if network == "" {
		return nil
	}
	address, err := openShellGitFixtureAddress(inputs.upstreamCIDRs)
	if err != nil {
		return err
	}
	node := "k3d-" + state.Cluster + "-server-0"
	if err := r.run(ctx, r.engine, "network", "connect", "--gw-priority", "-100", network, node); err != nil {
		return fmt.Errorf("attach the k3d node to fixture network %s: %w", network, err)
	}
	server := fmt.Sprintf("github.com:53 {\n    hosts {\n        %[1]s github.com\n        %[1]s api.github.com\n    }\n}\n", address)
	dns := map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": kubernetesMetadata("coredns-custom", "kube-system", map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}),
		"data":     map[string]string{openShellGitDNSConfigMapKey: server},
	}
	if err := r.writeAndApply(ctx, state, "openshell-git-fixture-dns", dns); err != nil {
		return err
	}
	if err := r.run(ctx, "kubectl", "-n", "kube-system", "rollout", "restart", "deployment/coredns"); err != nil {
		return err
	}
	return r.run(ctx, "kubectl", "-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout", timeout.String())
}

// trustOpenShellSupervisor derives a local supervisor image whose CA bundle
// also trusts the selected CA. The supervisor terminates Sandbox TLS and
// re-originates it to GitHub and the model endpoint with its own image's bundle.
// The container is created, never started; commit keeps the image's config.
func (r *runner) trustOpenShellSupervisor(ctx context.Context, state *developmentState, root, source string, localOnly bool, caPath string) (string, func() error, error) {
	extra, err := readDevelopmentCABundle(caPath)
	if err != nil {
		return "", nil, fmt.Errorf("%s: %w", openShellSupervisorCASelector, err)
	}
	if _, err := r.output(ctx, r.engine, "image", "inspect", source); err != nil {
		if localOnly {
			return "", nil, fmt.Errorf("OpenShell candidate image must still exist locally at import: %s", source)
		}
		if err := r.run(ctx, r.engine, "pull", source); err != nil {
			return "", nil, err
		}
	}
	derived := "openclaw-development/openshell-supervisor-trust:" + state.Cluster
	if _, err := r.output(ctx, r.engine, "image", "inspect", derived); err == nil {
		return "", nil, fmt.Errorf("OpenShell development staging image already exists: %s", derived)
	}
	container := "openclaw-development-supervisor-trust-" + state.Cluster
	if _, err := r.output(ctx, r.engine, "create", "--name", container, source); err != nil {
		return "", nil, fmt.Errorf("stage the OpenShell supervisor image: %w", err)
	}
	removeContainer := func() error {
		if _, err := r.output(context.WithoutCancel(ctx), r.engine, "rm", "--force", container); err != nil {
			return fmt.Errorf("remove the OpenShell supervisor staging container: %w", err)
		}
		return nil
	}
	const bundlePath = "/etc/ssl/certs/ca-certificates.crt"
	bundle := filepath.Join(root, "supervisor-ca-certificates.crt")
	if err := r.run(ctx, r.engine, "cp", container+":"+bundlePath, bundle); err != nil {
		return "", nil, errors.Join(fmt.Errorf("read the supervisor CA bundle %s: %w", bundlePath, err), removeContainer())
	}
	base, err := os.ReadFile(bundle)
	if err == nil {
		err = os.Remove(bundle)
	}
	if err == nil {
		// exclusiveWrite sets the mode past the umask, and cp keeps it: the
		// supervisor reads the bundle as a non-root user.
		err = exclusiveWrite(bundle, append(append(bytes.TrimRight(base, "\n"), '\n'), extra...), 0644)
	}
	if err == nil {
		err = r.run(ctx, r.engine, "cp", bundle, container+":"+bundlePath)
	}
	committed := false
	if err == nil {
		_, err = r.output(ctx, r.engine, "commit", container, derived)
		committed = err == nil
	}
	err = errors.Join(err, removeContainer())
	if err != nil && committed {
		if _, removeErr := r.output(context.WithoutCancel(ctx), r.engine, "image", "rm", derived); removeErr != nil {
			err = errors.Join(err, fmt.Errorf("remove the trusted supervisor staging image: %w", removeErr))
		}
	}
	if removeErr := os.Remove(bundle); removeErr != nil && !os.IsNotExist(removeErr) {
		err = errors.Join(err, removeErr)
	}
	if err != nil {
		return "", nil, fmt.Errorf("derive the trusted OpenShell supervisor image: %w", err)
	}
	fmt.Fprintf(r.opts.Out, "OpenShell supervisor trusts %s\n", caPath)
	release := func() error {
		if _, err := r.output(context.WithoutCancel(ctx), r.engine, "image", "rm", derived); err != nil {
			return fmt.Errorf("remove the trusted supervisor staging image: %w", err)
		}
		return nil
	}
	return derived, release, nil
}

func openShellGitHostname(state *developmentState) string {
	return openShellGitService + "." + state.PlatformNamespace + ".svc"
}

func openShellGitEndpoint(state *developmentState) string {
	return fmt.Sprintf("https://%s:%d", openShellGitHostname(state), openShellGitPort)
}

func openShellGitGatewayMiddleware(state *developmentState) gatewayMiddleware {
	return gatewayMiddleware{name: openShellGitRegistration, endpoint: openShellGitEndpoint(state), audience: openShellGitAudience,
		timeout: openShellGitTimeout, caConfigMap: openShellGitCAConfigMap, payload: openShellGitPayload}
}

// developmentOpenShellGitGatewayValues selects native PKI and mTLS on the stock
// chart. With middleware it also registers the worker's request-phase service
// in gatewayConfig and mounts its public CA read-only.
func developmentOpenShellGitGatewayValues(state *developmentState, middleware bool) map[string]any {
	server := map[string]any{
		"disableTls": false,
		"auth":       map[string]any{"allowUnauthenticatedUsers": false},
		"tls":        map[string]any{"enableMtls": true},
	}
	values := map[string]any{"pkiInitJob": map[string]any{"enabled": true}, "server": server}
	if !middleware {
		return values
	}
	m := openShellGitGatewayMiddleware(state)
	values["gatewayConfig"] = map[string]any{"openshell.supervisor.middleware": []any{map[string]any{
		"name": m.name, "grpc_endpoint": m.endpoint, "tls_ca_cert_path": openShellGitCAMount + "/ca.crt",
		"audience": m.audience, "allow_insecure_transport": false, "max_payload_bytes": m.payload, "timeout": m.timeout,
	}}}
	server["extraVolumes"] = []any{map[string]any{"name": "oce-git-ca", "configMap": map[string]any{
		"name": openShellGitCAConfigMap, "items": []any{map[string]string{"key": "ca.crt", "path": "ca.crt"}},
	}}}
	server["extraVolumeMounts"] = []any{map[string]any{"name": "oce-git-ca", "mountPath": openShellGitCAMount, "readOnly": true}}
	return values
}

func writeOpenShellGitGatewayValues(state *developmentState, name string, middleware bool) (string, error) {
	data, err := json.Marshal(developmentOpenShellGitGatewayValues(state, middleware))
	if err != nil {
		return "", err
	}
	path := filepath.Join(state.directory, name)
	return path, exclusiveWrite(path, data, 0600)
}

// checkOpenShellGitChart renders the selected Gateway chart with the final
// registration before installing it: Helm silently ignores unknown values.
func (r *runner) checkOpenShellGitChart(ctx context.Context, state *developmentState, assets *openShellDevelopmentAssets) error {
	rendered, err := r.renderOpenShellGatewayChart(ctx, state, assets, developmentOpenShellGitGatewayValues(state, true))
	if err != nil {
		return fmt.Errorf("cannot render the OpenShell Gateway chart with the Git middleware: %w", err)
	}
	if err := verifyOpenShellGatewayChart(rendered, state, []gatewayMiddleware{openShellGitGatewayMiddleware(state)}); err != nil {
		return fmt.Errorf("OpenShell Git: %w", err)
	}
	return nil
}

// openShellGitClients are the trusted middleware callers: the Gateway and the
// supervisors of operator-mode workspace Namespaces.
func openShellGitClients(state *developmentState) []any {
	return []any{
		map[string]any{
			"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": state.PlatformNamespace}},
			"podSelector":       map[string]any{"matchLabels": map[string]string{"app.kubernetes.io/name": "openshell", "app.kubernetes.io/instance": openShellGatewayService}},
		},
		map[string]any{
			"namespaceSelector": map[string]any{"matchLabels": map[string]string{openShellOperatorNamespaceLabel: openShellOperatorNamespaceValue}, "matchExpressions": []any{map[string]any{"key": "openclaw.dev/namespace", "operator": "Exists"}}},
			"podSelector":       map[string]any{"matchLabels": map[string]string{openShellManagedByLabel: openShellManagedByValue, openShellBoundaryRoleLabel: openShellSupervisorRole}},
		},
	}
}

// openShellGitAuthorityEgressPolicy lets workspace supervisors reach the worker's middleware port.
func openShellGitAuthorityEgressPolicy(state *developmentState) map[string]any {
	return map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]string{"name": "allow-openshell-git-authority"},
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": map[string]string{openShellManagedByLabel: openShellManagedByValue, openShellBoundaryRoleLabel: openShellSupervisorRole}},
			"policyTypes": []string{"Egress"},
			"egress": []any{map[string]any{
				"to": []any{map[string]any{
					"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": state.PlatformNamespace}},
					"podSelector":       map[string]any{"matchLabels": map[string]string{"app.kubernetes.io/name": "openclaw-enterprise", "app.kubernetes.io/instance": "openclaw-enterprise", "app.kubernetes.io/component": "worker"}},
				}},
				"ports": []any{map[string]any{"protocol": "TCP", "port": openShellGitPort}},
			}},
		},
	}
}

// openShellGitRepoDriver is the drivers.repo.openShell block. The worker
// verifies Gateway JWTs with the public key and identifier native PKI generated.
func openShellGitRepoDriver(state *developmentState) map[string]any {
	return map[string]any{"registrationName": openShellGitRegistration, "authority": map[string]any{
		"host": "0.0.0.0", "port": openShellGitPort,
		"certificatePath":     "/etc/openclaw/openshell-git/tls.crt",
		"privateKeyPath":      "/etc/openclaw/openshell-git/tls.key",
		"issuerPublicKeyPath": "/etc/openclaw/openshell-git/gateway-public.pem",
		"issuer":              "openshell-gateway:" + openShellGatewayService, "audience": openShellGitAudience, "keyId": state.gatewayKeyID,
	}}
}

func openShellGitHelmValues(state *developmentState) map[string]any {
	return map[string]any{
		"enabled": true, "port": openShellGitPort,
		"tlsSecretName": openShellGitTLSSecret, "issuerPublicKeyConfigMapName": openShellGitIssuerConfigMap,
		"clients": openShellGitClients(state),
	}
}

// prepareOpenShellGitMaterial writes the middleware's serving TLS, its public
// CA for the Gateway, and the Gateway's public JWT key for the worker. The
// Gateway's signing key never leaves its Secret.
func (r *runner) prepareOpenShellGitMaterial(ctx context.Context, state *developmentState) error {
	hostname := openShellGitHostname(state)
	if err := writeDevelopmentTLS(state.directory, "openshell-git", "OCC development OpenShell Git CA", []string{hostname, hostname + ".cluster.local"}); err != nil {
		return err
	}
	encoded, err := r.output(ctx, "kubectl", "get", "secret", openShellGatewayService+"-jwt-keys", "--namespace", state.PlatformNamespace, "-o", `jsonpath={.data.public\.pem}`)
	if err != nil {
		return err
	}
	public, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		return fmt.Errorf("OpenShell JWT public key is not base64")
	}
	if block, rest := pem.Decode(public); block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return fmt.Errorf("OpenShell JWT public key must be one PEM public key")
	} else if _, err := x509.ParsePKIXPublicKey(block.Bytes); err != nil {
		return fmt.Errorf("OpenShell JWT public key is invalid")
	}
	material := map[string][]byte{}
	for _, name := range []string{"openshell-git-tls.crt", "openshell-git-tls.key", "openshell-git-ca.crt"} {
		data, err := os.ReadFile(filepath.Join(state.directory, name))
		if err != nil {
			return err
		}
		material[name] = data
	}
	labels := map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}
	resources := map[string]any{"apiVersion": "v1", "kind": "List", "items": []any{
		map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": kubernetesMetadata(openShellGitTLSSecret, state.PlatformNamespace, labels), "type": "kubernetes.io/tls",
			"stringData": map[string]string{"tls.crt": string(material["openshell-git-tls.crt"]), "tls.key": string(material["openshell-git-tls.key"])}},
		map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": kubernetesMetadata(openShellGitCAConfigMap, state.PlatformNamespace, labels),
			"data": map[string]string{"ca.crt": string(material["openshell-git-ca.crt"])}},
		map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": kubernetesMetadata(openShellGitIssuerConfigMap, state.PlatformNamespace, labels),
			"data": map[string]string{"gateway-public.pem": string(public)}},
	}}
	return r.writeAndApply(ctx, state, "openshell-git-material", resources)
}

// registerOpenShellGitMiddleware upgrades the Gateway with the registration
// once the worker serves it; Gateway startup calls Describe and refuses an
// unavailable service. The new configuration checksum rolls the Gateway Pod.
func (r *runner) registerOpenShellGitMiddleware(ctx context.Context, state *developmentState, assets *openShellDevelopmentAssets, timeout time.Duration) error {
	values, err := writeOpenShellGitGatewayValues(state, "openshell-git-middleware-values.json", true)
	if err != nil {
		return err
	}
	fmt.Fprintf(r.opts.Out, "Registering the %s supervisor middleware with the OpenShell Gateway...\n", openShellGitRegistration)
	args := []string{"upgrade", openShellGatewayService, assets.gatewayChart, "--namespace", state.PlatformNamespace, "--kubeconfig", filepath.Join(state.directory, "kubeconfig"), "--kube-context", "k3d-" + state.Cluster, "--timeout", timeout.String(), "--wait"}
	if err := r.run(ctx, "helm", append(args, openShellGatewayValues(state, assets, values)...)...); err != nil {
		return err
	}
	return r.run(ctx, "kubectl", "rollout", "status", "statefulset/"+openShellGatewayService, "--namespace", state.PlatformNamespace, "--timeout", timeout.String())
}

// sandboxPoliciesReachGitHub names the first operator policy whose endpoint
// is a GitHub host. Only the Git route may reach those hosts; startup refuses
// the overlap, so report it before any effect.
func sandboxPoliciesReachGitHub(policies []any) string {
	for _, item := range policies {
		policy, _ := item.(map[string]any)
		endpoints, _ := policy["endpoints"].([]any)
		for _, entry := range endpoints {
			endpoint, _ := entry.(map[string]any)
			host, _ := endpoint["host"].(string)
			host = strings.TrimSuffix(strings.ToLower(host), ".")
			if host == "github.com" || host == "api.github.com" {
				name, _ := policy["name"].(string)
				return name
			}
		}
	}
	return ""
}

// checkOpenShellGitPolicies requires the operator's Sandbox network policy
// file: the Driver needs at least one policy, and the stock source-control
// policy for github.com is withdrawn for this route.
func checkOpenShellGitPolicies(policies []any) error {
	if len(policies) == 0 {
		return fmt.Errorf("%s requires --sandbox-network-policy-file with at least one policy that does not reach GitHub (the route replaces the default source-control policy)", openShellGitSelector)
	}
	if name := sandboxPoliciesReachGitHub(policies); name != "" {
		return fmt.Errorf("%s: Sandbox network policy %q reaches a GitHub host; only the OpenShell Git route may", openShellGitSelector, name)
	}
	return nil
}
