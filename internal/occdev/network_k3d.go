package occdev

import (
	"context"
	"crypto/rand"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	developmentGatewayPort = 8080
	// Compute's ordinary allow policies (allow-gateway-ingress included) only select Pods that
	// carry the ordinary network profile; the probe target must look like a real Gateway Pod.
	// Keep in sync with apps/controller/src/drivers/compute/kubernetes/resources/network.ts.
	workloadRoleLabel          = "openclaw.dev/workload-role"
	networkProfileLabel        = "openclaw.dev/network-profile"
	ordinaryNetworkProfile     = "broad-egress-v1"
	developmentGatewayWorkload = "gateway"
)

// developmentGatewayProbeLabels returns fresh labels for the synthetic Gateway probe target.
func developmentGatewayProbeLabels() map[string]string {
	return map[string]string{
		workloadRoleLabel:   developmentGatewayWorkload,
		networkProfileLabel: ordinaryNetworkProfile,
	}
}

// developmentResolverK3dDefault, as OCC_DEVELOPMENT_K3D_DNS_RESOLVER, keeps
// k3d's own node resolver (its gateway DNS rewriting) on every host.
const developmentResolverK3dDefault = "k3d"

// Seams for tests: the host resolver files and the host operating system.
var (
	readHostResolverFile = os.ReadFile
	developmentHostOS    = runtime.GOOS
)

// prepareDevelopmentResolver only changes the resolver of the owned k3d node.
// An explicit address is needed when k3d's host-gateway DNS forwarding is unavailable.
// On Docker that forwarding fails when the engine writes its DNS rules with
// iptables-nft, because the node runs iptables in legacy mode, so the node gets
// an automatic resolver unless the setting selects another address or k3d's default.
// nodeImage is the image or k3d channel the profile passes to k3d for the node.
func (r *runner) prepareDevelopmentResolver(ctx context.Context, state *developmentState, nodeImage string) ([]string, error) {
	value := r.env["OCC_DEVELOPMENT_K3D_DNS_RESOLVER"]
	if value == developmentResolverK3dDefault {
		return nil, nil
	}
	if value == "" {
		var origin string
		value, origin = r.automaticDevelopmentResolver(ctx, nodeImage)
		if value == "" {
			return nil, nil
		}
		r.automaticNodeResolver, r.automaticNodeResolverOrigin = value, origin
		fmt.Fprintf(r.opts.Out, "Using %s DNS resolver %s for the k3d node (set OCC_DEVELOPMENT_K3D_DNS_RESOLVER to choose another, or to %s to keep k3d's default).\n", origin, value, developmentResolverK3dDefault)
	}
	address, err := netip.ParseAddr(value)
	if err != nil || !address.Is4() || !address.IsGlobalUnicast() {
		return nil, fmt.Errorf("OCC_DEVELOPMENT_K3D_DNS_RESOLVER must be a non-loopback IPv4 address or %s", developmentResolverK3dDefault)
	}
	path := filepath.Join(state.directory, "node-resolv.conf")
	if err := exclusiveWrite(path, []byte("nameserver "+address.String()+"\n"), 0644); err != nil {
		return nil, err
	}
	// k3d's DNS fix rewrites /etc/resolv.conf and conflicts with an explicit mount.
	r.env["K3D_FIX_DNS"] = "false"
	return []string{"--volume", path + ":/etc/resolv.conf:ro@server:0"}, nil
}

// automaticDevelopmentResolver returns the node resolver for an unset
// OCC_DEVELOPMENT_K3D_DNS_RESOLVER and where it came from, or "" to keep k3d's
// default. Linux Docker uses the host's upstream resolver, where k3d's gateway
// refuses queries on iptables-nft hosts. On macOS, Docker Desktop's gateway
// drops them, and the Mac's own resolvers may be reachable only from the host,
// so a Docker Desktop node gets the resolver Docker gives containers on its
// default bridge. Other macOS Docker engines keep k3d's default.
func (r *runner) automaticDevelopmentResolver(ctx context.Context, nodeImage string) (address, origin string) {
	if r.engine != "docker" {
		return "", ""
	}
	switch developmentHostOS {
	case "linux":
		return hostUpstreamResolver(readHostResolverFile), "this host's upstream"
	case "darwin":
		return r.dockerDesktopBridgeResolver(ctx, nodeImage), "Docker Desktop's default-bridge"
	}
	return "", ""
}

type developmentProbeResource struct {
	path, apiPath, uid, kind string
}

type developmentNetworkProbe struct {
	runner    *runner
	state     *developmentState
	id        string
	image     string
	resources []developmentProbeResource
}

func (p *developmentNetworkProbe) create(ctx context.Context, name string, resource any) error {
	data, err := json.Marshal(resource)
	if err != nil {
		return err
	}
	path := filepath.Join(p.state.directory, "network-probe-"+p.id+"-"+name+".json")
	if err := exclusiveWrite(path, data, 0600); err != nil {
		return err
	}
	created, err := p.runner.output(ctx, "kubectl", "create", "-f", path, "-o", "json")
	if err != nil {
		return err
	}
	var object struct {
		Kind     string `json:"kind"`
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
			UID       string `json:"uid"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(created, &object); err != nil || object.Metadata.Name == "" || object.Metadata.UID == "" {
		return fmt.Errorf("network probe resource creation did not return ownership metadata")
	}
	var apiPath string
	switch object.Kind {
	case "Namespace":
		apiPath = "/api/v1/namespaces/" + object.Metadata.Name
	case "Pod":
		apiPath = "/api/v1/namespaces/" + object.Metadata.Namespace + "/pods/" + object.Metadata.Name
	case "NetworkPolicy":
		apiPath = "/apis/networking.k8s.io/v1/namespaces/" + object.Metadata.Namespace + "/networkpolicies/" + object.Metadata.Name
	default:
		return fmt.Errorf("unexpected network probe resource kind")
	}
	p.resources = append(p.resources, developmentProbeResource{path: path, apiPath: apiPath, uid: object.Metadata.UID, kind: object.Kind})
	return nil
}

func (p *developmentNetworkProbe) namespace(ctx context.Context, name string) error {
	if err := p.create(ctx, name, map[string]any{
		"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]any{"name": name, "labels": map[string]string{"openclaw.dev/network-probe": p.id}},
	}); err != nil {
		return err
	}
	return nil
}

func (p *developmentNetworkProbe) delete(ctx context.Context, resource developmentProbeResource) error {
	options, err := json.Marshal(map[string]any{
		"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": map[string]string{"uid": resource.uid},
	})
	if err != nil {
		return err
	}
	optionsPath := fmt.Sprintf("%s.delete.json", resource.path)
	if err := exclusiveWrite(optionsPath, options, 0600); err != nil {
		return err
	}
	if _, err := p.runner.output(ctx, "kubectl", "delete", "--raw", resource.apiPath, "-f", optionsPath); err != nil {
		return fmt.Errorf("delete network probe %s: %w", resource.apiPath, err)
	}
	return nil
}

func (p *developmentNetworkProbe) cleanup() error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	// Start deletion of adjacent Pods together so their graceful shutdowns
	// overlap. Wait for each group before removing the policy that restricts
	// selector-matching sources, and stop if any deletion cannot be verified.
	for end := len(p.resources) - 1; end >= 0; {
		start := end
		kind := p.resources[end].kind
		if kind == "Pod" || kind == "Namespace" {
			for start > 0 && p.resources[start-1].kind == kind {
				start--
			}
		}
		for i := end; i >= start; i-- {
			if err := p.delete(ctx, p.resources[i]); err != nil {
				return err
			}
		}
		for i := end; i >= start; i-- {
			resource := p.resources[i]
			if _, err := p.runner.output(ctx, "kubectl", "wait", "--for=delete", "-f", resource.path, "--timeout=60s"); err != nil {
				return fmt.Errorf("wait for network probe %s deletion: %w", resource.apiPath, err)
			}
		}
		end = start - 1
	}
	return nil
}

func (p *developmentNetworkProbe) pod(ctx context.Context, namespace, name string, labels map[string]string, server bool) error {
	labels["openclaw.dev/network-probe"] = p.id
	script := "setInterval(() => {}, 60000)"
	if server {
		script = "require('node:http').createServer((q,s)=>s.end('occ-network-probe')).listen(8080,'0.0.0.0')"
	}
	return p.create(ctx, namespace+"-"+name, map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"namespace": namespace, "name": name, "labels": labels},
		"spec": map[string]any{
			"automountServiceAccountToken": false, "restartPolicy": "Never", "terminationGracePeriodSeconds": 1,
			"securityContext": map[string]any{"runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 1000, "seccompProfile": map[string]string{"type": "RuntimeDefault"}},
			"containers": []any{map[string]any{
				"name": "probe", "image": p.image, "imagePullPolicy": "Never",
				"command":         []string{"node", "-e", script},
				"securityContext": map[string]any{"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "capabilities": map[string]any{"drop": []string{"ALL"}}},
				"resources":       map[string]any{"requests": map[string]string{"cpu": "10m", "memory": "32Mi"}, "limits": map[string]string{"cpu": "200m", "memory": "128Mi"}},
			}},
		},
	})
}

func (p *developmentNetworkProbe) podIP(ctx context.Context, namespace, name string, timeout time.Duration) (string, error) {
	if _, err := p.runner.output(ctx, "kubectl", "-n", namespace, "wait", "--for=condition=Ready", "pod/"+name, "--timeout", timeout.String()); err != nil {
		return "", err
	}
	data, err := p.runner.output(ctx, "kubectl", "-n", namespace, "get", "pod", name, "-o", "json")
	if err != nil {
		return "", err
	}
	var pod struct {
		Status struct {
			PodIP string `json:"podIP"`
		} `json:"status"`
	}
	if err := json.Unmarshal(data, &pod); err != nil {
		return "", fmt.Errorf("invalid network probe Pod")
	}
	address, err := netip.ParseAddr(pod.Status.PodIP)
	if err != nil || !address.Is4() {
		return "", fmt.Errorf("network probe Pod has no IPv4 address")
	}
	return address.String(), nil
}

// Both negative peers must have working access to a separate control target.
// The allowed peer must reach the protected target before and after denials.
const developmentProbeRequest = `
const http = require("node:http");
const [mode, target, control] = process.argv.slice(1);
function request(host) {
  return new Promise((resolve, reject) => {
    const q = http.get({host, port: 8080, timeout: 1500,
      headers: {"x-forwarded-user": "untrusted", "x-forwarded-for": "127.0.0.1"}}, r => {
      let body = "";
      r.on("data", b => body += b);
      r.on("end", () => resolve({status: r.statusCode, body}));
    });
    q.on("timeout", () => q.destroy(Object.assign(new Error("timeout"), {code: "ETIMEDOUT"})));
    q.on("error", reject);
  });
}
(async () => {
  const baseline = await request(control);
  if (baseline.status !== 200 || baseline.body !== "occ-network-probe") throw new Error("control failed");
  if (mode === "allow") {
    const response = await request(target);
    if (response.status !== 200 || response.body !== "occ-network-probe") throw new Error("allowed target failed");
    return;
  }
  try {
    await request(target);
    throw new Error("untrusted peer reached target");
  } catch (error) {
    if (error.code !== "ECONNREFUSED" && error.code !== "ETIMEDOUT") throw error;
  }
  const after = await request(control);
  if (after.status !== 200 || after.body !== "occ-network-probe") throw new Error("control failed after denial");
})().catch(() => process.exit(1));
`

func (p *developmentNetworkProbe) check(ctx context.Context, namespace, pod, mode, target, control string) bool {
	_, err := p.runner.output(ctx, "kubectl", "-n", namespace, "exec", pod, "--", "node", "-e", developmentProbeRequest, mode, target, control)
	return err == nil
}

// verifyDevelopmentNetworkPolicy checks actual packet delivery, not merely the
// existence of NetworkPolicy objects. A successful run is a point-in-time proof.
func (r *runner) verifyDevelopmentNetworkPolicy(ctx context.Context, state *developmentState, image, targetNamespace, envoyNamespace string, actual bool, timeout time.Duration) (result error) {
	p := &developmentNetworkProbe{runner: r, state: state, id: strings.ToLower(rand.Text()[:12]), image: image}
	defer func() {
		if err := p.cleanup(); err != nil {
			result = errors.Join(result, fmt.Errorf("network probe cleanup failed: %w", err))
		}
	}()
	otherNamespace := "occ-netcheck-other-" + p.id
	if err := p.namespace(ctx, otherNamespace); err != nil {
		return err
	}
	if !actual {
		targetNamespace = "occ-netcheck-target-" + p.id
		envoyNamespace = "occ-netcheck-envoy-" + p.id
		if err := p.namespace(ctx, targetNamespace); err != nil {
			return err
		}
		if err := p.namespace(ctx, envoyNamespace); err != nil {
			return err
		}
		policy := map[string]any{
			"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
			"metadata": map[string]any{"namespace": targetNamespace, "name": "probe-ingress"},
			"spec": map[string]any{
				"podSelector": map[string]any{"matchLabels": developmentGatewayProbeLabels()},
				"policyTypes": []string{"Ingress"},
				"ingress": []any{map[string]any{
					"from": []any{map[string]any{
						"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": envoyNamespace}},
						"podSelector": map[string]any{"matchLabels": map[string]string{
							"gateway.envoyproxy.io/owning-gateway-namespace": state.PlatformNamespace,
							"gateway.envoyproxy.io/owning-gateway-name":      "openclaw-enterprise-agent-gateways",
						}},
					}},
					"ports": []any{map[string]any{"protocol": "TCP", "port": developmentGatewayPort}},
				}},
			},
		}
		if err := p.create(ctx, "policy", policy); err != nil {
			return err
		}
	}
	target := "occ-netcheck-target-" + p.id
	control := "occ-netcheck-control-" + p.id
	allowed := "occ-netcheck-allowed-" + p.id
	wrongLabel := "occ-netcheck-wrong-label-" + p.id
	wrongNamespace := "occ-netcheck-wrong-ns-" + p.id
	peerLabels := func() map[string]string {
		return map[string]string{
			"gateway.envoyproxy.io/owning-gateway-namespace": state.PlatformNamespace,
			"gateway.envoyproxy.io/owning-gateway-name":      "openclaw-enterprise-agent-gateways",
		}
	}
	for _, pod := range []struct {
		namespace, name string
		labels          map[string]string
		server          bool
	}{
		{targetNamespace, target, developmentGatewayProbeLabels(), true},
		{otherNamespace, control, map[string]string{}, true},
	} {
		if err := p.pod(ctx, pod.namespace, pod.name, pod.labels, pod.server); err != nil {
			return err
		}
	}
	targetIP, err := p.podIP(ctx, targetNamespace, target, timeout)
	if err != nil {
		return err
	}
	controlIP, err := p.podIP(ctx, otherNamespace, control, timeout)
	if err != nil {
		return err
	}
	// A selector-matching probe must not be able to contact other Gateways.
	egress := map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
		"metadata": map[string]any{"namespace": envoyNamespace, "name": "occ-netcheck-egress-" + p.id},
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": map[string]string{"openclaw.dev/network-probe": p.id}},
			"policyTypes": []string{"Egress"},
			"egress": []any{map[string]any{
				"to": []any{
					map[string]any{"ipBlock": map[string]string{"cidr": targetIP + "/32"}},
					map[string]any{"ipBlock": map[string]string{"cidr": controlIP + "/32"}},
				},
				"ports": []any{map[string]any{"protocol": "TCP", "port": developmentGatewayPort}},
			}},
		},
	}
	if err := p.create(ctx, "egress", egress); err != nil {
		return err
	}
	for _, pod := range []struct {
		namespace, name string
		labels          map[string]string
	}{
		{envoyNamespace, allowed, peerLabels()},
		{envoyNamespace, wrongLabel, map[string]string{}},
		{otherNamespace, wrongNamespace, peerLabels()},
	} {
		if err := p.pod(ctx, pod.namespace, pod.name, pod.labels, false); err != nil {
			return err
		}
	}
	for _, pod := range []struct{ namespace, name string }{{envoyNamespace, allowed}, {envoyNamespace, wrongLabel}, {otherNamespace, wrongNamespace}} {
		if _, err := p.podIP(ctx, pod.namespace, pod.name, timeout); err != nil {
			return err
		}
	}
	consecutive := 0
	err = poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		ok := p.check(ctx, envoyNamespace, allowed, "allow", targetIP, controlIP) &&
			p.check(ctx, otherNamespace, wrongNamespace, "deny", targetIP, controlIP) &&
			p.check(ctx, envoyNamespace, wrongLabel, "deny", targetIP, controlIP) &&
			p.check(ctx, envoyNamespace, allowed, "allow", targetIP, controlIP)
		if !ok {
			consecutive = 0
			return false, nil
		}
		consecutive++
		return consecutive >= 3, nil
	})
	if err != nil {
		return fmt.Errorf("Kubernetes NetworkPolicy enforcement could not be verified: %w", err)
	}
	return nil
}

func (r *runner) developmentGatewayNamespace(ctx context.Context, namespaceID string) (string, error) {
	data, err := r.output(ctx, "kubectl", "get", "namespaces", "-l", "openclaw.dev/gateway-namespace="+namespaceID, "-o", "json")
	if err != nil {
		return "", err
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name        string            `json:"name"`
				Annotations map[string]string `json:"annotations"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &list); err != nil || len(list.Items) != 1 ||
		list.Items[0].Metadata.Name == "" || list.Items[0].Metadata.Annotations["openclaw.dev/namespace-id"] != namespaceID {
		return "", fmt.Errorf("expected one owned development gateway Namespace")
	}
	return list.Items[0].Metadata.Name, nil
}
