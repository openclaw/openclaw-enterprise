package occdev

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/netip"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"time"
)

// K3dAPIEgressOptions binds infrastructure reconciliation to one installed
// namespace. This command runs as the local cluster owner, never in an Agent.
type K3dAPIEgressOptions struct {
	DockerContext, Cluster, Namespace, NamespaceUID, Release string
	APIPort                                                  int
	Apply, Watch                                             bool
	Interval                                                 time.Duration
	Out                                                      io.Writer
}

const apiEgressPolicy = "openclaw-enterprise-dependency-egress"

type apiEgressPlan struct {
	Changed       bool
	Before, After []string
	Patch         []map[string]any
}

// ReconcileK3dAPIEgress maintains only the chart's API destination rule. Docker
// access already grants host/cluster administration; do not delegate it to OCC
// or workload identities. The namespace UID prevents adoption after recreation.
func ReconcileK3dAPIEgress(ctx context.Context, opts K3dAPIEgressOptions) error {
	name := regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$`)
	for _, value := range []string{opts.Cluster, opts.Namespace, opts.Release} {
		if !name.MatchString(value) {
			return fmt.Errorf("cluster, namespace and release must be DNS labels")
		}
	}
	if opts.DockerContext == "" || opts.NamespaceUID == "" || opts.APIPort < 1 || opts.APIPort > 65535 {
		return fmt.Errorf("explicit Docker context, namespace UID and API port are required")
	}
	if opts.Watch && (!opts.Apply || opts.Interval < time.Second || opts.Interval > time.Minute) {
		return fmt.Errorf("watch requires apply and an interval from 1s to 1m")
	}
	if opts.Out == nil {
		opts.Out = io.Discard
	}
	failed, first := false, true
	for {
		iteration, cancel := context.WithTimeout(ctx, 25*time.Second)
		plan, err := reconcileK3dAPIEgressOnce(iteration, opts)
		cancel()
		entry := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "namespace": opts.Namespace, "policy": apiEgressPolicy}
		if err != nil {
			entry["event"], entry["error"] = "api_egress_refused", err.Error()
		} else {
			entry["event"], entry["changed"], entry["applied"] = "api_egress_synchronized", plan.Changed, opts.Apply
			entry["before"], entry["after"] = plan.Before, plan.After
		}
		// Log the initial result, changes and recovery. Never emit credentials or
		// subprocess output, which can contain Kubernetes/Docker authentication.
		if first || !opts.Watch || plan.Changed || failed || err != nil {
			if writeErr := json.NewEncoder(opts.Out).Encode(entry); writeErr != nil {
				return writeErr
			}
		}
		if !opts.Watch {
			return err
		}
		failed = err != nil
		first = false
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(opts.Interval):
		}
	}
}

func reconcileK3dAPIEgressOnce(ctx context.Context, opts K3dAPIEgressOptions) (apiEgressPlan, error) {
	var empty apiEgressPlan
	docker := func(input []byte, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, "docker", append([]string{"--context", opts.DockerContext}, args...)...)
		if input != nil {
			cmd.Stdin = bytes.NewReader(input)
		}
		data, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("local cluster command failed; no command output recorded")
		}
		return data, nil
	}
	transport, err := docker(nil, "context", "inspect", opts.DockerContext, "--format", "{{.Endpoints.docker.Host}}")
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(transport)), "unix:///") {
		return empty, fmt.Errorf("reconciliation requires an explicit local Unix-socket Docker context")
	}
	ids, err := docker(nil, "ps", "--filter", "label=k3d.cluster="+opts.Cluster, "--filter", "label=k3d.role=server", "--format", "{{.ID}}")
	if err != nil {
		return empty, err
	}
	servers := strings.Fields(string(ids))
	if len(servers) == 0 || len(servers) > 16 {
		return empty, fmt.Errorf("expected 1 to 16 running owned k3d servers")
	}
	data, err := docker(nil, append([]string{"inspect"}, servers...)...)
	if err != nil {
		return empty, err
	}
	var nodes []struct {
		ID              string
		Config          struct{ Labels map[string]string }
		State           struct{ Running bool }
		NetworkSettings struct {
			Networks map[string]struct{ IPAddress string }
		}
	}
	if json.Unmarshal(data, &nodes) != nil || len(nodes) != len(servers) {
		return empty, fmt.Errorf("invalid k3d server inventory")
	}
	addresses := map[string]bool{}
	for _, node := range nodes {
		if !node.State.Running || node.Config.Labels["k3d.cluster"] != opts.Cluster || node.Config.Labels["k3d.role"] != "server" {
			return empty, fmt.Errorf("k3d server ownership changed")
		}
		address, err := netip.ParseAddr(node.NetworkSettings.Networks["k3d-"+opts.Cluster].IPAddress)
		if err != nil || !address.Is4() {
			return empty, fmt.Errorf("owned k3d server has no IPv4 address on its cluster network")
		}
		addresses[address.String()] = true
	}
	// The existing k3s administrator runs inside an owned control-plane server.
	// Loopback bypasses the broken Pod egress path, not Kubernetes authentication.
	// No credential is extracted, copied or exposed to another component.
	kube := func(input []byte, args ...string) ([]byte, error) {
		prefix := []string{"exec"}
		if input != nil {
			prefix = append(prefix, "-i")
		}
		prefix = append(prefix, nodes[0].ID, "kubectl", "--request-timeout=8s")
		return docker(input, append(prefix, args...)...)
	}
	ep, err := kube(nil, "-n", "default", "get", "endpoints", "kubernetes", "-o", "json")
	if err != nil {
		return empty, fmt.Errorf("cannot read Kubernetes API endpoints")
	}
	policy, err := kube(nil, "-n", opts.Namespace, "get", "networkpolicy", apiEgressPolicy, "-o", "json")
	if err != nil {
		return empty, fmt.Errorf("cannot read installed dependency policy")
	}
	// Validate the namespace after acquiring the policy. Replacement before this
	// read changes the namespace UID; replacement afterward fails the policy UID
	// and resource-version preconditions below. Never adopt a new installation.
	ns, err := kube(nil, "get", "namespace", opts.Namespace, "-o", "json")
	if err != nil {
		return empty, fmt.Errorf("cannot read installation namespace")
	}
	var namespace struct {
		Metadata struct {
			UID string `json:"uid"`
		} `json:"metadata"`
	}
	if json.Unmarshal(ns, &namespace) != nil || namespace.Metadata.UID != opts.NamespaceUID {
		return empty, fmt.Errorf("installation namespace UID does not match")
	}
	plan, err := planAPIEgress(ep, policy, addresses, opts)
	if err != nil || !plan.Changed || !opts.Apply {
		return plan, err
	}
	patch, err := json.Marshal(plan.Patch)
	if err != nil {
		return empty, err
	}
	// JSON Patch tests bind the write to the exact object and resource version
	// read above. A concurrent Helm/operator edit fails; the next cycle rereads.
	if _, err := kube(patch, "-n", opts.Namespace, "patch", "networkpolicy", apiEgressPolicy, "--type=json", "--patch-file=/dev/stdin"); err != nil {
		return empty, fmt.Errorf("policy patch failed or conflicted; no unguarded write attempted")
	}
	return plan, nil
}

func planAPIEgress(endpointJSON, policyJSON []byte, serverIPs map[string]bool, opts K3dAPIEgressOptions) (apiEgressPlan, error) {
	var plan apiEgressPlan
	var endpoint struct {
		Metadata struct{ Name, Namespace string }
		Subsets  []struct {
			Addresses []struct{ IP string }
			Ports     []struct {
				Name, Protocol string
				Port           int
			}
		}
	}
	if json.Unmarshal(endpointJSON, &endpoint) != nil || endpoint.Metadata.Name != "kubernetes" || endpoint.Metadata.Namespace != "default" || len(endpoint.Subsets) == 0 {
		return plan, fmt.Errorf("invalid Kubernetes API endpoint resource")
	}
	for _, subset := range endpoint.Subsets {
		if len(subset.Ports) != 1 || subset.Ports[0].Name != "https" || subset.Ports[0].Protocol != "TCP" || subset.Ports[0].Port != opts.APIPort || len(subset.Addresses) == 0 {
			return plan, fmt.Errorf("Kubernetes API endpoint ports or ready addresses do not match the installation")
		}
		for _, item := range subset.Addresses {
			addr, err := netip.ParseAddr(item.IP)
			if err != nil || !addr.Is4() || !serverIPs[item.IP] {
				return plan, fmt.Errorf("Kubernetes API endpoint is not an owned k3d server address")
			}
			plan.After = append(plan.After, addr.String()+"/32")
		}
	}
	slices.Sort(plan.After)
	plan.After = slices.Compact(plan.After)
	var policy struct {
		Metadata struct {
			Name, Namespace, UID, ResourceVersion string
			Annotations                           map[string]string
		}
		Spec struct {
			PodSelector struct {
				MatchLabels      map[string]string
				MatchExpressions []struct {
					Key, Operator string
					Values        []string
				}
			}
			PolicyTypes []string
			Egress      []struct {
				To    []map[string]json.RawMessage
				Ports []struct {
					Protocol string
					Port     int
					EndPort  *int
				}
			}
		}
	}
	if json.Unmarshal(policyJSON, &policy) != nil {
		return plan, fmt.Errorf("invalid dependency policy")
	}
	m := policy.Metadata
	if m.Name != apiEgressPolicy || m.Namespace != opts.Namespace || m.UID == "" || m.ResourceVersion == "" || m.Annotations["meta.helm.sh/release-name"] != opts.Release || m.Annotations["meta.helm.sh/release-namespace"] != opts.Namespace {
		return plan, fmt.Errorf("dependency policy is not owned by the selected Helm installation")
	}
	s := policy.Spec.PodSelector
	if len(s.MatchLabels) != 2 || s.MatchLabels["app.kubernetes.io/name"] != "openclaw-enterprise" || s.MatchLabels["app.kubernetes.io/instance"] != opts.Release || len(s.MatchExpressions) != 1 || len(policy.Spec.PolicyTypes) != 1 || policy.Spec.PolicyTypes[0] != "Egress" {
		return plan, fmt.Errorf("dependency policy selector differs from the chart control-plane selector")
	}
	expression := s.MatchExpressions[0]
	slices.Sort(expression.Values)
	if expression.Key != "app.kubernetes.io/component" || expression.Operator != "In" || !slices.Equal(expression.Values, []string{"api", "initialization", "worker"}) {
		return plan, fmt.Errorf("dependency policy selects unexpected components")
	}
	index := -1
	for i, rule := range policy.Spec.Egress {
		for _, port := range rule.Ports {
			if port.EndPort != nil && port.Port <= opts.APIPort && *port.EndPort >= opts.APIPort {
				return plan, fmt.Errorf("API port occurs in a ranged egress rule")
			}
			if port.Port == opts.APIPort && len(rule.Ports) != 1 {
				return plan, fmt.Errorf("API port occurs in a combined egress rule")
			}
		}
		if len(rule.Ports) != 1 || rule.Ports[0].Protocol != "TCP" || rule.Ports[0].Port != opts.APIPort {
			continue
		}
		if index != -1 || len(rule.To) == 0 {
			return plan, fmt.Errorf("API egress rule is missing or ambiguous")
		}
		index = i
		for _, peer := range rule.To {
			var block struct {
				CIDR   string
				Except []string
			}
			if len(peer) != 1 || json.Unmarshal(peer["ipBlock"], &block) != nil || len(block.Except) > 0 {
				return plan, fmt.Errorf("API egress is not an exact IP rule")
			}
			prefix, err := netip.ParsePrefix(block.CIDR)
			if err != nil || !prefix.Addr().Is4() || prefix.Bits() != 32 {
				return plan, fmt.Errorf("API egress must contain only exact IPv4 /32 destinations")
			}
			plan.Before = append(plan.Before, block.CIDR)
		}
	}
	if index == -1 {
		return plan, fmt.Errorf("no chart API egress rule matches the configured port")
	}
	slices.Sort(plan.Before)
	plan.Changed = !slices.Equal(plan.Before, plan.After)
	peers := make([]map[string]any, 0, len(plan.After))
	for _, cidr := range plan.After {
		peers = append(peers, map[string]any{"ipBlock": map[string]string{"cidr": cidr}})
	}
	plan.Patch = []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": m.UID},
		{"op": "test", "path": "/metadata/resourceVersion", "value": m.ResourceVersion},
		{"op": "replace", "path": fmt.Sprintf("/spec/egress/%d/to", index), "value": peers},
	}
	return plan, nil
}
