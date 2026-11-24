package occdev

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"sort"

	"go.yaml.in/yaml/v3"
)

// Read the chart's normal channel defaults and use the same settings in the
// external Installation. Discovery belongs to local setup, not the worker.
func (r *runner) prepareDevelopmentChannelEgress(ctx context.Context, state *developmentState) (map[string]any, error) {
	data, err := os.ReadFile(filepath.Join(r.opts.Repository, "deploy/helm/openclaw-enterprise/values.yaml"))
	if err != nil {
		return nil, err
	}
	var chart struct {
		ChannelEgress map[string]any `yaml:"channelEgress"`
	}
	if err := yaml.Unmarshal(data, &chart); err != nil {
		return nil, err
	}
	egress := chart.ChannelEgress
	if egress == nil {
		return nil, fmt.Errorf("chart channel defaults are missing")
	}
	nodes, err := r.output(ctx, "kubectl", "get", "nodes", "-o", "json")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []struct {
			Spec struct {
				PodCIDRs []string `json:"podCIDRs"`
			} `json:"spec"`
			Status struct {
				Addresses []struct {
					Address string `json:"address"`
				} `json:"addresses"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(nodes, &list); err != nil {
		return nil, err
	}
	exclusions := map[string]bool{}
	for _, node := range list.Items {
		if len(node.Spec.PodCIDRs) == 0 {
			return nil, fmt.Errorf("node Pod CIDRs are missing; channel exclusions cannot be discovered")
		}
		for _, cidr := range node.Spec.PodCIDRs {
			prefix, err := netip.ParsePrefix(cidr)
			if err != nil {
				return nil, err
			}
			exclusions[prefix.Masked().String()] = true
		}
		for _, item := range node.Status.Addresses {
			if address, err := netip.ParseAddr(item.Address); err == nil {
				exclusions[netip.PrefixFrom(address, address.BitLen()).String()] = true
			}
		}
	}
	ranges, err := r.output(ctx, "kubectl", "get", "servicecidrs", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("discover Service CIDRs for channel exclusions: %w", err)
	}
	var services struct {
		Items []struct {
			Spec struct {
				CIDRs []string `json:"cidrs"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal(ranges, &services); err != nil {
		return nil, err
	}
	if len(list.Items) == 0 || len(services.Items) == 0 {
		return nil, fmt.Errorf("node or Service CIDR discovery is incomplete")
	}
	for _, service := range services.Items {
		if len(service.Spec.CIDRs) == 0 {
			return nil, fmt.Errorf("Service CIDRs are missing")
		}
		for _, cidr := range service.Spec.CIDRs {
			prefix, err := netip.ParsePrefix(cidr)
			if err != nil {
				return nil, err
			}
			exclusions[prefix.Masked().String()] = true
		}
	}
	cidrs := make([]string, 0, len(exclusions))
	for cidr := range exclusions {
		cidrs = append(cidrs, cidr)
	}
	sort.Strings(cidrs)
	egress["excludedCidrs"] = cidrs
	egress["enabled"] = true
	installationPath := filepath.Join(state.directory, "installation.yaml")
	data, err = os.ReadFile(installationPath)
	if err != nil {
		return nil, err
	}
	var installation map[string]any
	if err := yaml.Unmarshal(data, &installation); err != nil {
		return nil, err
	}
	compute := installation["drivers"].(map[string]any)["compute"].(map[string]any)["configuration"].(map[string]any)
	settings := map[string]any{"gatewayNamespace": state.PlatformNamespace}
	for _, field := range []string{"gatewayName", "envoyNamespace", "serviceName", "listenerPortStart", "listenerPortEnd", "occListenerPort", "inspectionPort", "excludedCidrs"} {
		settings[field] = egress[field]
	}
	compute["runtime"].(map[string]any)["channelEgress"] = settings
	data, err = yaml.Marshal(installation)
	if err != nil {
		return nil, err
	}
	if err := replaceDevelopmentFile(installationPath, data); err != nil {
		return nil, err
	}
	return egress, nil
}
