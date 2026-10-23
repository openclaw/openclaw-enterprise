package occdev

import (
	"context"
	"fmt"
	"net/netip"
	"regexp"
	"time"
)

// The Kubernetes API server reaches a workload Pod's private status port
// (TCP/18791) through its Pod proxy. Compute admits only the configured
// network.pluginStatusProxySourceCidrs to that port. Without them, startup
// evidence, plugin status and diagnostics are unavailable, and a dedicated
// Codex Gateway cannot confirm a hot-applied workspace node, so every first
// deploy rolls the Gateway a second time to put the node into its pod spec.
//
// The development cluster is one k3s server using its default Flannel
// backend. The API server runs in the node's host network and reaches a
// local Pod over the cni0 bridge, so the source is that bridge's address.
var developmentStatusProxyRoute = regexp.MustCompile(`\bdev\s+cni0(?:\s|$)`)
var developmentStatusProxyRouteSource = regexp.MustCompile(`\bsrc\s+(\S+)`)

var developmentStatusProxyWait = 2 * time.Minute

func (r *runner) developmentStatusProxySource(ctx context.Context, state *developmentState) (string, error) {
	server := "k3d-" + state.Cluster + "-server-0"
	prefix, err := r.developmentNodePodCIDR(ctx, server, 28)
	if err != nil {
		return "", err
	}
	// Any Pod address on this node routes through the bridge. Skip the network
	// address and the bridge's own address, which the kernel reports as local.
	destination := prefix.Addr().Next().Next()
	var source string
	err = poll(ctx, developmentStatusProxyWait, func(ctx context.Context) (bool, error) {
		route, err := r.output(ctx, r.engine, "exec", server, "ip", "route", "get", destination.String())
		if err != nil {
			if ctx.Err() != nil {
				return false, ctx.Err()
			}
			return false, err
		}
		// cni0 appears with the node's first Pod. Before that the lookup takes
		// the default route, whose source must never be admitted.
		if !developmentStatusProxyRoute.Match(route) {
			return false, nil
		}
		source, err = developmentStatusProxyCidr(route, prefix)
		return err == nil, err
	})
	if err != nil {
		return "", fmt.Errorf("wait for the k3d Pod bridge route used by the API server Pod proxy: %w", err)
	}
	return source, nil
}

func developmentStatusProxyCidr(route []byte, podCIDR netip.Prefix) (string, error) {
	sources := developmentStatusProxyRouteSource.FindAllSubmatch(route, -1)
	if len(sources) != 1 {
		return "", fmt.Errorf("unable to determine the k3d API server Pod proxy source address")
	}
	source, err := netip.ParseAddr(string(sources[0][1]))
	if err != nil || !source.Is4() || !podCIDR.Contains(source) || source == podCIDR.Addr() {
		return "", fmt.Errorf("the k3d API server Pod proxy source must be a host address in the node Pod CIDR")
	}
	return netip.PrefixFrom(source, 32).String(), nil
}
