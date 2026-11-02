package occdev

import (
	"context"
	"encoding/base64"
	"encoding/json/v2"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	developmentEgressService    = "openclaw-enterprise-egress-authority"
	developmentEgressPort       = 9444
	developmentEgressDriver     = "egress-openshell-development"
	developmentEgressMiddleware = "oce-authority"
	developmentEgressAudience   = "oce-egress"
	developmentEgressCA         = "occ-egress-ca"
	developmentEgressPayload    = 4 * 1024 * 1024
	developmentEgressTimeout    = "30s"
)

var developmentDatabaseName = regexp.MustCompile(`^openclaw_k8s_[a-z0-9_]+$`)

// CheckDevelopmentProfile validates protected egress and its related selectors
// before Compute dispatch, including callers that otherwise bypass Up.
func CheckDevelopmentProfile() error {
	r := newRunner(Options{})
	controlPlane := r.setting("OCC_DEVELOPMENT_CONTROL_PLANE", "compose")
	sandbox := r.setting("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
	protected, err := r.protectedEgressSelection(controlPlane, sandbox)
	if err != nil {
		return err
	}
	if protected && r.env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "kubernetes" {
		return fmt.Errorf("protected egress requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes")
	}
	if _, err := r.selectedDevelopmentDatabase(controlPlane); err != nil {
		return err
	}
	if _, selected := r.env["OCC_DEVELOPMENT_DATABASE_NAME"]; selected && r.env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "kubernetes" {
		return fmt.Errorf("OCC_DEVELOPMENT_DATABASE_NAME requires Kubernetes Compute")
	}
	return nil
}

func (r *runner) protectedEgressSelection(controlPlane, sandbox string) (bool, error) {
	value := r.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"]
	if value != "" && value != "0" && value != "1" {
		return false, fmt.Errorf("OCC_DEVELOPMENT_PROTECTED_EGRESS must be 0 or 1")
	}
	if address, selected := r.env["OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"]; selected {
		ip, err := netip.ParseAddr(address)
		if value != "1" || err != nil || !ip.Is4() || !ip.IsPrivate() || ip.String() != address {
			return false, fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP requires protected egress and a canonical private IPv4 address for the owned host")
		}
	}
	if value != "1" {
		return false, nil
	}
	if controlPlane != "kubernetes" || sandbox != "openshell" {
		return false, fmt.Errorf("protected egress requires Kubernetes control plane and OpenShell Sandbox")
	}

	return true, nil
}

func (r *runner) selectedDevelopmentDatabase(controlPlane string) (string, error) {
	name, selected := r.env["OCC_DEVELOPMENT_DATABASE_NAME"]
	if !selected {
		return "openclaw_enterprise", nil
	}
	if controlPlane != "kubernetes" || len(name) > 63 || !developmentDatabaseName.MatchString(name) {
		return "", fmt.Errorf("OCC_DEVELOPMENT_DATABASE_NAME requires Kubernetes control plane and an openclaw_k8s_ name of at most 63 lowercase letters, digits or underscores")
	}
	return name, nil
}

func developmentAuthorityHostname(state *developmentState) string {
	return developmentEgressService + "." + state.PlatformNamespace + ".svc.cluster.local"
}

// Prepare only authority TLS and public trust before the Gateway's native PKI
// hook. The hook owns its server/client certificates and signed supervisor JWT.
func (r *runner) prepareDevelopmentEgress(ctx context.Context, state *developmentState) error {
	if err := writeDevelopmentTLS(state.directory, "egress", "OCC development authority CA", []string{developmentAuthorityHostname(state)}); err != nil {
		return err
	}
	material := make(map[string]string)
	for _, key := range []string{"tls.crt", "tls.key", "ca.crt"} {
		data, err := os.ReadFile(filepath.Join(state.directory, "egress-"+key))
		if err != nil {
			return err
		}
		material[key] = string(data)
	}
	labels := map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}
	resources := map[string]any{"apiVersion": "v1", "kind": "List", "items": []any{
		map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": kubernetesMetadata("occ-egress-tls", state.PlatformNamespace, labels), "type": "kubernetes.io/tls", "stringData": map[string]string{"tls.crt": material["tls.crt"], "tls.key": material["tls.key"]}},
		map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": kubernetesMetadata(developmentEgressCA, state.PlatformNamespace, labels), "data": map[string]string{"ca.crt": material["ca.crt"]}},
	}}
	return r.writeAndApply(ctx, state, "egress-tls", resources)
}

func developmentAuthorityEndpoint(state *developmentState) string {
	return fmt.Sprintf("https://%s:%d", developmentAuthorityHostname(state), developmentEgressPort)
}

func developmentProtectedOpenShellValues(state *developmentState) map[string]any {
	values := map[string]any{
		"pkiInitJob": map[string]any{"enabled": true},
		"server": map[string]any{
			"disableTls": false,
			"auth":       map[string]any{"allowUnauthenticatedUsers": false},
			"tls":        map[string]any{"enableMtls": true},
		},
		"gatewayConfig": map[string]any{
			"openshell.supervisor.middleware": []any{map[string]any{
				"name":                     developmentEgressMiddleware,
				"grpc_endpoint":            developmentAuthorityEndpoint(state),
				"audience":                 developmentEgressAudience,
				"tls_ca_cert_path":         "/etc/openshell/oce-authority/ca.crt",
				"allow_insecure_transport": false,
				"max_payload_bytes":        developmentEgressPayload,
				"timeout":                  developmentEgressTimeout,
				"binding_policy":           "allowlist",
				"bindings":                 []string{"http_request_pre_credentials"},
			}},
		},
	}
	server := values["server"].(map[string]any)
	server["extraVolumes"] = []any{map[string]any{
		"name":      "oce-authority-ca",
		"configMap": map[string]any{"name": developmentEgressCA},
	}}
	server["extraVolumeMounts"] = []any{map[string]any{
		"name": "oce-authority-ca", "mountPath": "/etc/openshell/oce-authority", "readOnly": true,
	}}
	if state.OpenShellHostGatewayIP != "" {
		values["server"].(map[string]any)["hostGatewayIP"] = state.OpenShellHostGatewayIP
	}
	return values
}

func (r *runner) writeProtectedOpenShellValues(state *developmentState) (string, error) {
	data, err := json.Marshal(developmentProtectedOpenShellValues(state))
	if err != nil {
		return "", err
	}
	path := filepath.Join(state.directory, "openshell-protected-values.json")
	return path, exclusiveWrite(path, data, 0600)
}

func (r *runner) readDevelopmentEgressKeyID(ctx context.Context, state *developmentState) error {
	// Read just the public key identifier, never the JWT signing key or client key.
	encoded, err := r.output(ctx, "kubectl", "get", "secret", openShellGatewayService+"-jwt-keys", "--namespace", state.PlatformNamespace, "-o", "jsonpath={.data.kid}")
	if err != nil {
		return err
	}
	data, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		return fmt.Errorf("OpenShell JWT key identifier is not base64")
	}
	kid := strings.TrimSpace(string(data))
	if !regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`).MatchString(kid) {
		return fmt.Errorf("OpenShell JWT key identifier is invalid")
	}
	state.egressKeyID = kid
	return nil
}

func developmentEgressConfiguration(state *developmentState) map[string]any {
	return map[string]any{"id": developmentEgressDriver, "configuration": map[string]any{
		"middlewareName": developmentEgressMiddleware, "authorityScope": "execution",
		"authority": map[string]any{
			"host": "0.0.0.0", "port": developmentEgressPort,
			"certificatePath":     "/etc/openclaw/egress/tls/tls.crt",
			"privateKeyPath":      "/etc/openclaw/egress/tls/tls.key",
			"issuerPublicKeyPath": "/etc/openclaw/egress/issuer/issuer.pub",
			"issuer":              "openshell-gateway:" + openShellGatewayService, "audience": developmentEgressAudience, "keyId": state.egressKeyID,
		},
	}}
}

func developmentEgressChartValues(state *developmentState) map[string]any {
	return map[string]any{
		"enabled": true, "port": developmentEgressPort,
		"tlsSecretName": "occ-egress-tls", "issuerSecretName": openShellGatewayService + "-jwt-keys",
		"clients": []any{
			map[string]any{
				"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": state.PlatformNamespace}},
				"podSelector":       map[string]any{"matchLabels": map[string]string{"app.kubernetes.io/name": "openshell", "app.kubernetes.io/instance": openShellGatewayService}},
			},
			map[string]any{
				"namespaceSelector": map[string]any{"matchLabels": map[string]string{openShellOperatorNamespaceLabel: openShellOperatorNamespaceValue}, "matchExpressions": []any{map[string]any{"key": "openclaw.dev/namespace", "operator": "Exists"}}},
				"podSelector":       map[string]any{"matchLabels": map[string]string{openShellManagedByLabel: openShellManagedByValue, openShellBoundaryRoleLabel: openShellSupervisorRole}},
			},
		},
	}
}

func developmentAuthorityEgressPolicy(state *developmentState) map[string]any {
	return map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]string{"name": "allow-openshell-authority"},
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": map[string]string{openShellManagedByLabel: openShellManagedByValue, openShellBoundaryRoleLabel: openShellSupervisorRole}},
			"policyTypes": []string{"Egress"},
			"egress": []any{map[string]any{
				"to": []any{map[string]any{
					"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": state.PlatformNamespace}},
					"podSelector":       map[string]any{"matchLabels": map[string]string{"app.kubernetes.io/name": "openclaw-enterprise", "app.kubernetes.io/instance": "openclaw-enterprise", "app.kubernetes.io/component": "api"}},
				}},
				"ports": []any{map[string]any{"protocol": "TCP", "port": developmentEgressPort}},
			}},
		},
	}
}

func (r *runner) waitProtectedOpenShell(ctx context.Context, state *developmentState, timeout time.Duration) error {
	return r.run(ctx, "kubectl", "rollout", "status", "statefulset/"+openShellGatewayService, "--namespace", state.PlatformNamespace, "--timeout", timeout.String())
}
