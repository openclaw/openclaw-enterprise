package occdev

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
	"time"
)

// developmentNodeDNSName is resolved inside the k3d node right after cluster
// creation. Every image the launcher does not import is pulled by the node from
// a public registry, so a node that cannot resolve this name cannot start.
const developmentNodeDNSName = "registry-1.docker.io"

var (
	developmentNodeDNSAttempts       = 3
	developmentNodeDNSRetryDelay     = 2 * time.Second
	developmentNodeDNSAttemptTimeout = 20 * time.Second
)

// BusyBox nslookup (in the k3s image) and BIND nslookup both report a query that
// no server answered, and name a refusal ("Connection refused") when nothing
// listens at the resolver address. Only a refusal is fatal: a timeout can be a
// network that drops public DNS on purpose (a proxy-only network), so it warns.
var (
	developmentNodeDNSUnanswered = regexp.MustCompile(`no servers could be reached`)
	developmentNodeDNSRefused    = regexp.MustCompile(`(?i)connection refused`)
)

type developmentNodeDNSOutcome int

const (
	nodeDNSResolved developmentNodeDNSOutcome = iota
	// Nothing listens at the node's resolver address: image pulls will time out.
	nodeDNSRefused
	// The lookup failed for another reason (a timeout, no such name, no
	// nslookup in a custom node image, an engine error). Not proof of a dead
	// resolver.
	nodeDNSInconclusive
)

func classifyDevelopmentNodeDNS(output []byte, err error) developmentNodeDNSOutcome {
	if err == nil {
		return nodeDNSResolved
	}
	if developmentNodeDNSUnanswered.Match(output) && developmentNodeDNSRefused.Match(output) {
		return nodeDNSRefused
	}
	return nodeDNSInconclusive
}

// checkDevelopmentNodeDNS fails fast when the new node's resolver refuses
// queries. On a Docker host using iptables-nft, k3d points the node at the
// network gateway but its DNS forwarding rules are missing in the node's legacy
// iptables mode; without this check the first image pull times out minutes
// later. An inconclusive lookup only warns, so an unusual host is not blocked.
func (r *runner) checkDevelopmentNodeDNS(ctx context.Context, state *developmentState) error {
	server := "k3d-" + state.Cluster + "-server-0"
	outcome := nodeDNSInconclusive
	for attempt := 1; attempt <= developmentNodeDNSAttempts; attempt++ {
		if attempt > 1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(developmentNodeDNSRetryDelay):
			}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, developmentNodeDNSAttemptTimeout)
		output, err := r.command(attemptCtx, r.engine, "exec", server, "nslookup", developmentNodeDNSName).CombinedOutput()
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		outcome = classifyDevelopmentNodeDNS(output, err)
		if outcome != nodeDNSRefused {
			break
		}
	}
	switch outcome {
	case nodeDNSResolved:
		return nil
	case nodeDNSRefused:
		if r.automaticNodeResolver != "" {
			return automaticNodeDNSError(server, r.automaticNodeResolver)
		}
		configured := r.env["OCC_DEVELOPMENT_K3D_DNS_RESOLVER"]
		if configured == developmentResolverK3dDefault {
			configured = ""
		}
		return developmentNodeDNSError(server, configured, hostUpstreamResolver(readHostResolverFile))
	default:
		automatic := ""
		if r.automaticNodeResolver != "" {
			automatic = fmt.Sprintf(" The node uses this host's upstream resolver %s; OCC_DEVELOPMENT_K3D_DNS_RESOLVER=%s keeps k3d's default.", r.automaticNodeResolver, developmentResolverK3dDefault)
		}
		fmt.Fprintf(r.opts.Err, "Warning: could not confirm that the k3d node %s resolves %s; continuing.%s If image pulls stall, see OCC_DEVELOPMENT_K3D_DNS_RESOLVER in the local Kubernetes development guide.\n", server, developmentNodeDNSName, automatic)
		return nil
	}
}

func developmentNodeDNSError(server, configured, upstream string) error {
	if configured != "" {
		return fmt.Errorf("the k3d node %s cannot resolve %s: OCC_DEVELOPMENT_K3D_DNS_RESOLVER=%s refused the query; set it to an IPv4 DNS server the node can reach, or to %s to keep k3d's default node resolver", server, developmentNodeDNSName, configured, developmentResolverK3dDefault)
	}
	hint := ""
	if upstream != "" {
		hint = fmt.Sprintf(" (for example OCC_DEVELOPMENT_K3D_DNS_RESOLVER=%s, this host's upstream resolver)", upstream)
	}
	return errors.New("the k3d node " + server + " cannot resolve " + developmentNodeDNSName + ": its DNS resolver refused the query, so image pulls would time out. " +
		"k3d forwards node DNS through the container network gateway, which fails on some hosts (for example Docker using iptables-nft). " +
		"Set OCC_DEVELOPMENT_K3D_DNS_RESOLVER to an IPv4 DNS server the node can reach" + hint + " and run occ dev up again")
}

func automaticNodeDNSError(server, upstream string) error {
	return fmt.Errorf("the k3d node %s cannot resolve %s: this host's upstream resolver %s, which startup gave the node because OCC_DEVELOPMENT_K3D_DNS_RESOLVER is unset, refused the query; set OCC_DEVELOPMENT_K3D_DNS_RESOLVER to an IPv4 DNS server the node can reach, or to %s to keep k3d's default node resolver, and run occ dev up again", server, developmentNodeDNSName, upstream, developmentResolverK3dDefault)
}

// hostUpstreamResolver returns the host's first non-loopback IPv4 nameserver,
// preferring systemd-resolved's upstream list over its 127.0.0.53 stub.
func hostUpstreamResolver(read func(string) ([]byte, error)) string {
	for _, path := range []string{"/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"} {
		data, err := read(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) != 2 || fields[0] != "nameserver" {
				continue
			}
			address, err := netip.ParseAddr(fields[1])
			if err == nil && address.Is4() && address.IsGlobalUnicast() {
				return address.String()
			}
		}
	}
	return ""
}
