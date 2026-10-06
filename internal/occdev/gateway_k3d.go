package occdev

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json/v2"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

const (
	developmentGatewayName      = "openclaw-enterprise-agent-gateways"
	developmentGatewayNamespace = "oce-system"
	developmentEnvoyNamespace   = "envoy-gateway-system"
)

type developmentRoutingEndpoint struct {
	gatewayNamespace string
	hostname         string
	endpointPort     int
}

type composeDevelopmentRouting struct {
	endpoint          developmentRoutingEndpoint
	podCIDR           string
	trustedProxyCIDRs []string
	reference         string
	apiURL            string
	postgresCIDR      string
	nodeCIDR          string
	nodeContainer     string
}

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

func developmentCRDEstablished(data []byte) (bool, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return false, nil
	}
	var resource struct {
		Status struct {
			Conditions []struct {
				Type   string `json:"type"`
				Status string `json:"status"`
			} `json:"conditions"`
		} `json:"status"`
	}
	if err := json.Unmarshal(data, &resource); err != nil {
		return false, fmt.Errorf("invalid CustomResourceDefinition status: %w", err)
	}
	for _, condition := range resource.Status.Conditions {
		if condition.Type == "Established" && condition.Status == "True" {
			return true, nil
		}
	}
	return false, nil
}

func (r *runner) waitDevelopmentCRDEstablished(
	ctx context.Context,
	name string,
	timeout time.Duration,
) error {
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		data, err := r.output(ctx, "kubectl", "get", "crd", name, "--ignore-not-found", "-o", "json")
		if err != nil {
			return false, err
		}
		if len(bytes.TrimSpace(data)) == 0 {
			return false, nil
		}
		return developmentCRDEstablished(data)
	})
}

// K3s installs its Gateway API CRDs asynchronously through its bundled add-on.
// Their objects and Established conditions can appear in separate observations.
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
		if err := r.waitDevelopmentCRDEstablished(ctx, crd, timeout); err != nil {
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
			if err := r.waitDevelopmentCRDEstablished(ctx, crd, timeout); err != nil {
				return "", fmt.Errorf("wait for controller CRD %s to be established: %w", crd, err)
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
func configureDevelopmentRouting(
	state *developmentState,
	trustedProxyCIDRs []string,
	endpoint developmentRoutingEndpoint,
) error {
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
	network["gatewayTrustedProxyCidrs"] = append([]string(nil), trustedProxyCIDRs...)
	routing := map[string]any{
		"gatewayName":      developmentGatewayName,
		"gatewayNamespace": endpoint.gatewayNamespace,
		"envoyNamespace":   developmentEnvoyNamespace,
	}
	if endpoint.hostname != "" {
		routing["hostname"] = endpoint.hostname
	}
	if endpoint.endpointPort != 0 {
		routing["endpointPort"] = endpoint.endpointPort
	}
	compute["gatewayRouting"] = routing
	data, err = yaml.Marshal(installation)
	if err != nil {
		return err
	}
	return replaceDevelopmentFile(path, data)
}

func (r *runner) waitDevelopmentRouting(ctx context.Context, gatewayNamespace, podCIDR string, timeout time.Duration) ([]string, error) {
	if err := r.run(ctx, "kubectl", "-n", gatewayNamespace, "wait", "--for=condition=Ready", "certificate/"+developmentGatewayName+"-tls", "--timeout", timeout.String()); err != nil {
		return nil, err
	}
	if err := r.run(ctx, "kubectl", "-n", gatewayNamespace, "wait", "--for=condition=Programmed", "gateway/"+developmentGatewayName, "--timeout", timeout.String()); err != nil {
		return nil, err
	}
	selector := "app.kubernetes.io/component=proxy,app.kubernetes.io/managed-by=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=" + gatewayNamespace + ",gateway.envoyproxy.io/owning-gateway-name=" + developmentGatewayName
	if err := r.run(ctx, "kubectl", "-n", developmentEnvoyNamespace, "wait", "--for=condition=Ready", "pod", "-l", selector, "--timeout", timeout.String()); err != nil {
		return nil, err
	}
	data, err := r.output(ctx, "kubectl", "-n", developmentEnvoyNamespace, "get", "pods", "-l", selector, "-o", "json")
	if err != nil {
		return nil, err
	}
	return developmentRoutingProxyCIDRs(data, podCIDR)
}

func developmentRoutingProxyCIDRs(data []byte, podCIDR string) ([]string, error) {
	var pods struct {
		Items []struct {
			Status struct {
				PodIP string `json:"podIP"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &pods); err != nil || len(pods.Items) == 0 {
		return nil, fmt.Errorf("Envoy proxy Pods are missing or invalid")
	}
	prefix, err := netip.ParsePrefix(podCIDR)
	if err != nil {
		return nil, err
	}
	addresses := make(map[netip.Addr]struct{}, len(pods.Items))
	for _, pod := range pods.Items {
		address, err := netip.ParseAddr(pod.Status.PodIP)
		if err != nil || !prefix.Contains(address) {
			return nil, fmt.Errorf("Envoy proxy Pod address is outside the trusted k3d Pod CIDR")
		}
		addresses[address] = struct{}{}
	}
	trustedProxyCIDRs := make([]string, 0, len(addresses))
	for address := range addresses {
		trustedProxyCIDRs = append(trustedProxyCIDRs, netip.PrefixFrom(address, address.BitLen()).String())
	}
	sort.Strings(trustedProxyCIDRs)
	return trustedProxyCIDRs, nil
}

// OpenShell resolves a Sandbox's policy hostnames without cluster search
// domains, so its workspace node needs the route's fully qualified Service name.
// Other profiles keep the chart's default namespace-qualified name.
func developmentRoutingHostname(state *developmentState) string {
	if state.SandboxDriver != "openshell" {
		return ""
	}
	return developmentGatewayServiceName(state.PlatformNamespace) + "." + developmentEnvoyNamespace + ".svc.cluster.local"
}

func developmentGatewayServiceName(namespace string) string {
	digest := sha256.Sum256([]byte(namespace + "/" + developmentGatewayName))
	return "occ-gateway-" + hex.EncodeToString(digest[:])[:12]
}

func (r *runner) containerNetworkAddress(
	ctx context.Context,
	state *developmentState,
	container, network string,
) (string, error) {
	data, err := r.output(ctx, r.engine, "inspect", container)
	if err != nil {
		return "", err
	}
	var inspected []struct {
		NetworkSettings struct {
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := json.Unmarshal(data, &inspected); err != nil || len(inspected) != 1 {
		return "", fmt.Errorf("container %s has invalid network inspection data", container)
	}
	raw := inspected[0].NetworkSettings.Networks[network].IPAddress
	address, err := netip.ParseAddr(raw)
	if err != nil || !address.Is4() {
		return "", fmt.Errorf("container %s has no IPv4 address on %s", container, network)
	}
	return address.String(), nil
}

func (r *runner) composeServiceAddress(
	ctx context.Context,
	state *developmentState,
	service string,
) (string, error) {
	id, err := r.composeOutput(ctx, state, "ps", "--all", "-q", service)
	if err != nil {
		return "", err
	}
	container := strings.TrimSpace(string(id))
	if container == "" || strings.ContainsAny(container, "\r\n") {
		return "", fmt.Errorf("could not identify Compose service %s", service)
	}
	return r.containerNetworkAddress(ctx, state, container, state.ComposeProject+"_development")
}

func composeDevelopmentRoutingValues(
	routing *composeDevelopmentRouting,
	remoteNodeCIDRs []string,
) map[string]any {
	return map[string]any{
		"images": map[string]string{"controller": routing.reference},
		"auth":   map[string]string{"baseUrl": routing.apiURL},
		"bootstrap": map[string]any{
			"adminEmail": "admin@development.openclaw.invalid",
			"password":   map[string]string{"claimName": "bootstrap-password"},
		},
		"api": map[string]any{"clients": []any{map[string]any{
			"namespace": developmentEnvoyNamespace,
			"podLabels": map[string]string{"app.kubernetes.io/name": "envoy"},
		}}},
		"database":         map[string]any{"cidrs": []string{routing.postgresCIDR}},
		"cluster":          map[string]any{"cidrs": []string{routing.nodeCIDR}, "port": 6443},
		"agentNativeAdmin": map[string]any{"enabled": false},
		"gatewayRouting": map[string]any{
			"enabled":          true,
			"gatewayClassName": "eg",
			"gatewayName":      developmentGatewayName,
			"hostname":         routing.endpoint.hostname,
			"serviceType":      "NodePort",
			"apiKeySecretName": "occ-private-gateway-key",
			"remoteNodeCidrs":  remoteNodeCIDRs,
		},
	}
}

func (r *runner) applyComposeDevelopmentRouting(
	ctx context.Context,
	state *developmentState,
	routing *composeDevelopmentRouting,
	remoteNodeCIDRs []string,
	name string,
) error {
	values, err := json.Marshal(composeDevelopmentRoutingValues(routing, remoteNodeCIDRs))
	if err != nil {
		return err
	}
	valuesPath := filepath.Join(state.directory, name+"-values.json")
	if err := exclusiveWrite(valuesPath, values, 0600); err != nil {
		return err
	}
	manifest, err := r.output(
		ctx,
		"helm",
		"template",
		"openclaw-enterprise",
		"deploy/helm/openclaw-enterprise",
		"--namespace",
		developmentGatewayNamespace,
		"-f",
		valuesPath,
		"--show-only",
		"templates/gateway-routing.yaml",
	)
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(state.directory, name+".yaml")
	if err := exclusiveWrite(manifestPath, manifest, 0600); err != nil {
		return err
	}
	return r.run(ctx, "kubectl", "apply", "-f", manifestPath)
}

func (r *runner) composeGatewayNodePort(ctx context.Context) (int, error) {
	data, err := r.output(
		ctx,
		"kubectl",
		"-n",
		developmentEnvoyNamespace,
		"get",
		"service",
		developmentGatewayServiceName(developmentGatewayNamespace),
		"-o",
		"json",
	)
	if err != nil {
		return 0, err
	}
	var service struct {
		Spec struct {
			Ports []struct {
				Port     int `json:"port"`
				NodePort int `json:"nodePort"`
			} `json:"ports"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(data, &service); err != nil {
		return 0, fmt.Errorf("invalid Envoy Service")
	}
	for _, port := range service.Spec.Ports {
		if port.Port == 443 && port.NodePort > 0 && port.NodePort <= 65535 {
			return port.NodePort, nil
		}
	}
	return 0, fmt.Errorf("Envoy Service has no HTTPS NodePort")
}

func (r *runner) copyComposeGatewayCA(ctx context.Context, state *developmentState) error {
	name := developmentGatewayServiceName(developmentGatewayNamespace) + "-root"
	data, err := r.output(ctx, "kubectl", "-n", developmentGatewayNamespace, "get", "secret", name, "-o", "json")
	if err != nil {
		return err
	}
	var secret struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(data, &secret); err != nil {
		return fmt.Errorf("invalid private gateway CA Secret")
	}
	certificate, err := base64.StdEncoding.DecodeString(secret.Data["tls.crt"])
	if err != nil || bytes.Contains(certificate, []byte("PRIVATE KEY")) {
		return fmt.Errorf("private gateway CA Secret has invalid public certificate data")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(certificate) {
		return fmt.Errorf("private gateway CA Secret has invalid public certificate data")
	}
	return exclusiveWrite(filepath.Join(state.directory, "gateway-ca.crt"), certificate, 0600)
}

func (r *runner) prepareComposeDevelopmentRouting(
	ctx context.Context,
	state *developmentState,
	reference, apiURL string,
	timeout time.Duration,
) (*composeDevelopmentRouting, error) {
	podCIDR, err := r.installDevelopmentRoutingControllers(ctx, state, timeout)
	if err != nil {
		return nil, err
	}
	if err := r.ensureKubernetesNamespace(ctx, developmentGatewayNamespace); err != nil {
		return nil, err
	}
	key, err := randomDevelopmentSecret()
	if err != nil {
		return nil, err
	}
	if err := exclusiveWrite(filepath.Join(state.directory, "gateway-api-key"), []byte(key), 0600); err != nil {
		return nil, err
	}
	secret := map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata":   kubernetesMetadata("occ-private-gateway-key", developmentGatewayNamespace, map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}),
		"stringData": map[string]string{"occ": key},
	}
	if err := r.writeAndApply(ctx, state, "gateway-api-key", secret); err != nil {
		return nil, err
	}
	network := state.ComposeProject + "_development"
	nodeContainer := "k3d-" + state.Cluster + "-server-0"
	nodeAddress, err := r.containerNetworkAddress(ctx, state, nodeContainer, network)
	if err != nil {
		return nil, err
	}
	postgresAddress, err := r.composeServiceAddress(ctx, state, "postgres")
	if err != nil {
		return nil, err
	}
	routing := &composeDevelopmentRouting{
		endpoint: developmentRoutingEndpoint{
			gatewayNamespace: developmentGatewayNamespace,
			hostname:         nodeContainer,
		},
		podCIDR:       podCIDR,
		reference:     reference,
		apiURL:        apiURL,
		postgresCIDR:  postgresAddress + "/32",
		nodeCIDR:      nodeAddress + "/32",
		nodeContainer: nodeContainer,
	}
	if err := r.applyComposeDevelopmentRouting(ctx, state, routing, []string{routing.nodeCIDR}, "gateway-routing-bootstrap"); err != nil {
		return nil, err
	}
	routing.trustedProxyCIDRs, err = r.waitDevelopmentRouting(ctx, developmentGatewayNamespace, podCIDR, timeout)
	if err != nil {
		return nil, err
	}
	routing.endpoint.endpointPort, err = r.composeGatewayNodePort(ctx)
	if err != nil {
		return nil, err
	}
	if err := r.copyComposeGatewayCA(ctx, state); err != nil {
		return nil, err
	}
	return routing, nil
}

func (r *runner) finalizeComposeDevelopmentRouting(
	ctx context.Context,
	state *developmentState,
	routing *composeDevelopmentRouting,
	timeout time.Duration,
) error {
	controller, err := r.composeServiceAddress(ctx, state, "controller")
	if err != nil {
		return err
	}
	worker, err := r.composeServiceAddress(ctx, state, "worker-kubernetes")
	if err != nil {
		return err
	}
	remote := []string{controller + "/32", worker + "/32", routing.nodeCIDR}
	if err := r.applyComposeDevelopmentRouting(ctx, state, routing, remote, "gateway-routing"); err != nil {
		return err
	}
	trustedProxyCIDRs, err := r.waitDevelopmentRouting(ctx, developmentGatewayNamespace, routing.podCIDR, timeout)
	if err != nil {
		return err
	}
	if !slices.Equal(trustedProxyCIDRs, routing.trustedProxyCIDRs) {
		return fmt.Errorf("Envoy proxy Pod addresses changed while configuring private routing")
	}
	return nil
}
