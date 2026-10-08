package occdev

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

const statusProxyNode = `"get node k3d-occ-dev-test-server-0 -o json") echo '{"spec":{"podCIDR":"10.42.0.0/24"}}' ;;
`

func TestDevelopmentStatusProxySourceIsTheNodeBridgeAddress(t *testing.T) {
	fakeEngine(t, "kubectl", statusProxyNode)
	fakeEngine(t, "podman", `"exec k3d-occ-dev-test-server-0 ip route get 10.42.0.2") echo '10.42.0.2 dev cni0 src 10.42.0.1 uid 0'; echo '    cache' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	source, err := r.developmentStatusProxySource(context.Background(), &developmentState{Cluster: "occ-dev-test"})
	if err != nil {
		t.Fatal(err)
	}
	if source != "10.42.0.1/32" {
		t.Fatalf("unexpected status proxy source: %q", source)
	}
}

func TestDevelopmentStatusProxySourceNeverAdmitsTheDefaultRoute(t *testing.T) {
	// Before the node's first Pod there is no cni0 and the lookup takes eth0.
	// That source belongs to the container network, not the Pod proxy.
	fakeEngine(t, "kubectl", statusProxyNode)
	fakeEngine(t, "podman", `"exec k3d-occ-dev-test-server-0 ip route get 10.42.0.2") echo '10.42.0.2 via 172.18.0.1 dev eth0 src 172.18.0.3 uid 0' ;;
`)
	previous := developmentStatusProxyWait
	developmentStatusProxyWait = 10 * time.Millisecond
	t.Cleanup(func() { developmentStatusProxyWait = previous })
	r := &runner{engine: "podman", env: map[string]string{}}

	source, err := r.developmentStatusProxySource(context.Background(), &developmentState{Cluster: "occ-dev-test"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected a bridge route timeout, got %q, %v", source, err)
	}
}

func TestDevelopmentStatusProxyCidrRejectsSourcesOutsideThePodCIDR(t *testing.T) {
	podCIDR := netip.MustParsePrefix("10.42.0.0/24")
	for _, route := range []string{
		"10.42.0.2 dev cni0 src 172.18.0.3 uid 0",
		"10.42.0.2 dev cni0 src 10.42.0.0 uid 0",
		"10.42.0.2 dev cni0 uid 0",
		"10.42.0.2 dev cni0 src 10.42.0.1 src 10.42.0.9",
	} {
		if source, err := developmentStatusProxyCidr([]byte(route), podCIDR); err == nil {
			t.Fatalf("route %q admitted %q", route, source)
		}
	}
}

func TestDevelopmentInstallationAdmitsTheStatusProxySource(t *testing.T) {
	// Without these CIDRs a dedicated Codex first deploy rolls its Gateway a
	// second time (the node id goes into the pod spec) and Compute status and
	// diagnostics are unavailable. Keep the launcher setting them.
	state := &developmentState{Cluster: "occ-dev-test", SandboxDriver: "none", DeploymentMode: "k3d", PlatformNamespace: "oce-system", directory: t.TempDir()}
	if err := writeInstallation(state, "runtime@sha256:abc", nil, "", "", ""); err == nil {
		t.Fatal("an Installation without the status proxy source was written")
	}
	if err := writeInstallation(state, "runtime@sha256:abc", nil, "", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var installation struct {
		Drivers struct {
			Compute struct {
				Configuration struct {
					Network struct {
						PluginStatusProxySourceCidrs []string `yaml:"pluginStatusProxySourceCidrs"`
					} `yaml:"network"`
				} `yaml:"configuration"`
			} `yaml:"compute"`
		} `yaml:"drivers"`
	}
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	got := installation.Drivers.Compute.Configuration.Network.PluginStatusProxySourceCidrs
	if len(got) != 1 || got[0] != "10.42.0.1/32" {
		t.Fatalf("unexpected status proxy CIDRs: %v", got)
	}
}

func TestDevelopmentInstallationSizesAgentsFromMeasuredUse(t *testing.T) {
	// Requests cover measured use between turns and limits cover measured peaks:
	// a dedicated Codex Gateway was OOM-killed at 2Gi (D200), and a Codex Harness
	// running lint, tsc and tests together was OOM-killed at 2Gi and reached a
	// 4Gi limit.
	state := &developmentState{Cluster: "occ-dev-test", SandboxDriver: "none", DeploymentMode: "k3d", PlatformNamespace: "oce-system", directory: t.TempDir()}
	if err := writeInstallation(state, "runtime@sha256:abc", nil, "", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	type workload struct {
		Requests map[string]string `yaml:"requests"`
		Limits   map[string]string `yaml:"limits"`
	}
	var installation struct {
		Drivers struct {
			Compute struct {
				Configuration struct {
					Resources struct {
						Gateway workload `yaml:"gateway"`
						Agent   workload `yaml:"agent"`
					} `yaml:"resources"`
				} `yaml:"configuration"`
			} `yaml:"compute"`
		} `yaml:"drivers"`
	}
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	resources := installation.Drivers.Compute.Configuration.Resources
	if got := resources.Gateway.Limits["memory"]; got != "3Gi" {
		t.Fatalf("Gateway memory limit = %q, want 3Gi", got)
	}
	if got := resources.Gateway.Requests["memory"]; got != "1792Mi" {
		t.Fatalf("Gateway memory request = %q, want 1792Mi", got)
	}
	if got := resources.Agent.Limits["memory"]; got != "6Gi" {
		t.Fatalf("Harness memory limit = %q, want 6Gi", got)
	}
	if got := resources.Agent.Requests["memory"]; got != "768Mi" {
		t.Fatalf("Harness memory request = %q, want 768Mi", got)
	}
}

func TestDevelopmentStatusProxyWaitCancelsBlockedRouteQuery(t *testing.T) {
	fakeEngine(t, "kubectl", statusProxyNode)
	fakeEngine(t, "podman", `"exec k3d-occ-dev-test-server-0 ip route get 10.42.0.2") exec sleep 2 ;;
`)
	previous := developmentStatusProxyWait
	developmentStatusProxyWait = 100 * time.Millisecond
	t.Cleanup(func() { developmentStatusProxyWait = previous })
	r := &runner{engine: "podman", env: map[string]string{}}
	started := time.Now()
	source, err := r.developmentStatusProxySource(context.Background(), &developmentState{Cluster: "occ-dev-test"})
	if source != "" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected route query deadline, got %q, %v", source, err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("route query outlived the bridge wait deadline")
	}
}
