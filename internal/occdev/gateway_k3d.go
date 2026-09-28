package occdev

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// These controller manifests use the same versions and checksums as the real
// gateway-routing integration lane. k3s owns its Gateway API CRDs.
var developmentRoutingControllers = []struct {
	name   string
	url    string
	sha256 string
}{
	{"cert-manager", "https://github.com/cert-manager/cert-manager/releases/download/v1.18.4/cert-manager.yaml", "aff085b4f0126f67372e3a02cb18feb70eed37dbd4de01973a159e6c13482f83"},
	{"envoy-gateway", "https://github.com/envoyproxy/gateway/releases/download/v1.6.7/install.yaml", "9a250c698d78b92c670d9d2bd6bd54615f1dee41ddd520ece9704edf63088df8"},
}

func downloadDevelopmentRoutingManifest(ctx context.Context, url, expected string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 90 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download routing controller manifest: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download routing controller manifest: HTTP %d", response.StatusCode)
	}
	const limit = 32 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(data) > limit {
		return nil, fmt.Errorf("routing controller manifest could not be read within its size limit")
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != expected {
		return nil, fmt.Errorf("routing controller manifest checksum does not match the pinned version")
	}
	return data, nil
}

// Preserve k3s's Gateway API CRDs instead of replacing their storage versions.
func removeDevelopmentGatewayAPICRDs(data []byte) ([]byte, error) {
	var result bytes.Buffer
	var document bytes.Buffer
	flush := func() error {
		if len(bytes.TrimSpace(document.Bytes())) == 0 {
			document.Reset()
			return nil
		}
		var header struct {
			Kind     string `yaml:"kind"`
			Metadata struct {
				Name string `yaml:"name"`
			} `yaml:"metadata"`
		}
		if err := yaml.Unmarshal(document.Bytes(), &header); err != nil {
			return fmt.Errorf("invalid pinned Envoy manifest: %w", err)
		}
		if header.Kind != "CustomResourceDefinition" || !strings.HasSuffix(header.Metadata.Name, ".gateway.networking.k8s.io") {
			result.WriteString("---\n")
			result.Write(document.Bytes())
		}
		document.Reset()
		return nil
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 32*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimRight(line, " \t\r") == "---" {
			if err := flush(); err != nil {
				return nil, err
			}
			continue
		}
		document.WriteString(line)
		document.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}

// K3s installs its Gateway API CRDs asynchronously through its bundled add-on.
// Wait for creation before waiting for Established; kubectl wait alone fails
// immediately when a named CRD does not yet exist.
func (r *runner) waitDevelopmentGatewayAPICRDs(ctx context.Context, timeout time.Duration) (result error) {
	defer func() {
		if result == nil {
			return
		}
		diagnosticCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		fmt.Fprintln(r.opts.Err, "K3s Gateway API add-on diagnostics before rollback:")
		_ = r.run(diagnosticCtx, "kubectl", "-n", "kube-system", "get", "helmcharts.helm.cattle.io", "traefik-crd", "-o", "wide")
		_ = r.run(diagnosticCtx, "kubectl", "-n", "kube-system", "get", "jobs,pods", "-o", "wide")
		_ = r.run(diagnosticCtx, "kubectl", "-n", "kube-system", "describe", "pods", "-l", "job-name=helm-install-traefik-crd")
	}()
	for _, crd := range []string{"gatewayclasses.gateway.networking.k8s.io", "gateways.gateway.networking.k8s.io", "httproutes.gateway.networking.k8s.io", "referencegrants.gateway.networking.k8s.io"} {
		err := poll(ctx, timeout, func(ctx context.Context) (bool, error) {
			data, err := r.output(ctx, "kubectl", "get", "crd", crd, "--ignore-not-found", "-o", "name")
			if err != nil {
				return false, err
			}
			return len(data) > 0, nil
		})
		if err != nil {
			return fmt.Errorf("wait for k3s Gateway API CRD %s to be created: %w", crd, err)
		}
		if err := r.run(ctx, "kubectl", "wait", "--for=condition=Established", "crd/"+crd, "--timeout", timeout.String()); err != nil {
			return fmt.Errorf("wait for k3s Gateway API CRD %s to be established: %w", crd, err)
		}
	}
	return nil
}

func (r *runner) installDevelopmentRoutingControllers(ctx context.Context, state *developmentState, timeout time.Duration) (string, error) {
	for _, controller := range developmentRoutingControllers {
		data, err := downloadDevelopmentRoutingManifest(ctx, controller.url, controller.sha256)
		if err != nil {
			return "", fmt.Errorf("%s: %w", controller.name, err)
		}
		if controller.name == "envoy-gateway" {
			if err := r.waitDevelopmentGatewayAPICRDs(ctx, timeout); err != nil {
				return "", err
			}
			data, err = removeDevelopmentGatewayAPICRDs(data)
			if err != nil {
				return "", err
			}
		}
		path := filepath.Join(state.directory, controller.name+"-controller.yaml")
		if err := exclusiveWrite(path, data, 0600); err != nil {
			return "", err
		}
		args := []string{"apply", "-f", path}
		if controller.name == "envoy-gateway" {
			args = []string{"apply", "--server-side", "-f", path}
		}
		if err := r.run(ctx, "kubectl", args...); err != nil {
			return "", err
		}
		crds := []string{"certificates.cert-manager.io", "issuers.cert-manager.io", "clusterissuers.cert-manager.io"}
		namespace := "cert-manager"
		deployments := []string{"cert-manager", "cert-manager-cainjector", "cert-manager-webhook"}
		if controller.name == "envoy-gateway" {
			crds = []string{"securitypolicies.gateway.envoyproxy.io"}
			namespace = "envoy-gateway-system"
			deployments = []string{"envoy-gateway"}
		}
		for _, crd := range crds {
			if err := r.run(ctx, "kubectl", "wait", "--for=condition=Established", "crd/"+crd, "--timeout", timeout.String()); err != nil {
				return "", err
			}
		}
		for _, deployment := range deployments {
			if err := r.run(ctx, "kubectl", "-n", namespace, "rollout", "status", "deployment/"+deployment, "--timeout", timeout.String()); err != nil {
				return "", err
			}
		}
	}
	class := map[string]any{"apiVersion": "gateway.networking.k8s.io/v1", "kind": "GatewayClass", "metadata": map[string]any{"name": "eg", "labels": map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}}, "spec": map[string]string{"controllerName": "gateway.envoyproxy.io/gatewayclass-controller"}}
	if err := r.writeAndApply(ctx, state, "development-gateway-class", class); err != nil {
		return "", err
	}
	if err := r.run(ctx, "kubectl", "wait", "--for=condition=Accepted", "gatewayclass/eg", "--timeout", timeout.String()); err != nil {
		return "", err
	}
	nodeData, err := r.output(ctx, "kubectl", "get", "node", "k3d-"+state.Cluster+"-server-0", "-o", "json")
	if err != nil {
		return "", err
	}
	var node struct {
		Spec struct {
			PodCIDR string `json:"podCIDR"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(nodeData, &node); err != nil {
		return "", fmt.Errorf("invalid k3d node information")
	}
	prefix, err := netip.ParsePrefix(node.Spec.PodCIDR)
	if err != nil || !prefix.Addr().Is4() || prefix.Bits() < 16 || prefix != prefix.Masked() {
		return "", fmt.Errorf("k3d node must have a canonical bounded IPv4 Pod CIDR")
	}
	return prefix.String(), nil
}

// Configure routing before bootstrap so the initial Namespace receives the
// chart's route attachment and gateway-only ingress policy during provisioning.
func configureDevelopmentRouting(state *developmentState, podCIDR string) error {
	path := filepath.Join(state.directory, "installation.yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var installation map[string]any
	if err := yaml.Unmarshal(data, &installation); err != nil {
		return err
	}
	drivers, ok := installation["drivers"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Installation has no Drivers")
	}
	driver, ok := drivers["compute"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Installation has no Compute Driver")
	}
	compute, ok := driver["configuration"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Compute Driver has no configuration")
	}
	network, ok := compute["network"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Compute Driver has no network configuration")
	}
	delete(network, "gatewayClients")
	network["gatewayTrustedProxyCidrs"] = []string{podCIDR}
	compute["gatewayRouting"] = map[string]any{"gatewayName": "openclaw-enterprise-agent-gateways", "gatewayNamespace": state.PlatformNamespace, "envoyNamespace": "envoy-gateway-system"}
	data, err = yaml.Marshal(installation)
	if err != nil {
		return err
	}
	return replaceDevelopmentFile(path, data)
}

func (r *runner) waitDevelopmentRouting(ctx context.Context, state *developmentState, podCIDR string, timeout time.Duration) error {
	if err := r.run(ctx, "kubectl", "-n", state.PlatformNamespace, "wait", "--for=condition=Ready", "certificate/openclaw-enterprise-agent-gateways-tls", "--timeout", timeout.String()); err != nil {
		return err
	}
	if err := r.run(ctx, "kubectl", "-n", state.PlatformNamespace, "wait", "--for=condition=Programmed", "gateway/openclaw-enterprise-agent-gateways", "--timeout", timeout.String()); err != nil {
		return err
	}
	selector := "app.kubernetes.io/component=proxy,app.kubernetes.io/managed-by=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=" + state.PlatformNamespace + ",gateway.envoyproxy.io/owning-gateway-name=openclaw-enterprise-agent-gateways"
	if err := r.run(ctx, "kubectl", "-n", "envoy-gateway-system", "wait", "--for=condition=Ready", "pod", "-l", selector, "--timeout", timeout.String()); err != nil {
		return err
	}
	data, err := r.output(ctx, "kubectl", "-n", "envoy-gateway-system", "get", "pods", "-l", selector, "-o", "json")
	if err != nil {
		return err
	}
	var pods struct {
		Items []struct {
			Status struct {
				PodIP string `json:"podIP"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &pods); err != nil || len(pods.Items) == 0 {
		return fmt.Errorf("Envoy proxy Pods are missing or invalid")
	}
	prefix, err := netip.ParsePrefix(podCIDR)
	if err != nil {
		return err
	}
	for _, pod := range pods.Items {
		address, err := netip.ParseAddr(pod.Status.PodIP)
		if err != nil || !prefix.Contains(address) {
			return fmt.Errorf("Envoy proxy Pod address is outside the trusted k3d Pod CIDR")
		}
	}
	return nil
}
