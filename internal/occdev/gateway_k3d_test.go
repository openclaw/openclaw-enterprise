package occdev

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestConfigureDevelopmentRoutingUsesHybridEndpoint(t *testing.T) {
	directory := t.TempDir()
	state := &developmentState{directory: directory}
	path := filepath.Join(directory, "installation.yaml")
	if err := os.WriteFile(path, []byte(`drivers:
  compute:
    configuration:
      network:
        gatewayClients:
          - namespace: default
`), 0600); err != nil {
		t.Fatal(err)
	}
	endpoint := developmentRoutingEndpoint{
		gatewayNamespace: developmentGatewayNamespace,
		hostname:         "k3d-occ-dev-test-server-0",
		endpointPort:     30443,
	}
	if err := configureDevelopmentRouting(state, []string{"10.42.0.17/32"}, endpoint); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var installation struct {
		Drivers struct {
			Compute struct {
				Configuration struct {
					Network struct {
						GatewayClients           []any    `yaml:"gatewayClients"`
						GatewayTrustedProxyCidrs []string `yaml:"gatewayTrustedProxyCidrs"`
					} `yaml:"network"`
					GatewayRouting struct {
						GatewayName      string `yaml:"gatewayName"`
						GatewayNamespace string `yaml:"gatewayNamespace"`
						EnvoyNamespace   string `yaml:"envoyNamespace"`
						Hostname         string `yaml:"hostname"`
						EndpointPort     int    `yaml:"endpointPort"`
					} `yaml:"gatewayRouting"`
				} `yaml:"configuration"`
			} `yaml:"compute"`
		} `yaml:"drivers"`
	}
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	compute := installation.Drivers.Compute.Configuration
	if compute.Network.GatewayClients != nil {
		t.Fatalf("direct gateway clients remain configured: %v", compute.Network.GatewayClients)
	}
	if len(compute.Network.GatewayTrustedProxyCidrs) != 1 || compute.Network.GatewayTrustedProxyCidrs[0] != "10.42.0.17/32" {
		t.Fatalf("unexpected trusted proxy CIDRs: %v", compute.Network.GatewayTrustedProxyCidrs)
	}
	if compute.GatewayRouting.GatewayName != developmentGatewayName ||
		compute.GatewayRouting.GatewayNamespace != developmentGatewayNamespace ||
		compute.GatewayRouting.EnvoyNamespace != developmentEnvoyNamespace ||
		compute.GatewayRouting.Hostname != endpoint.hostname ||
		compute.GatewayRouting.EndpointPort != endpoint.endpointPort {
		t.Fatalf("unexpected hybrid routing endpoint: %+v", compute.GatewayRouting)
	}
	// Compose mounts the Installation into a different non-root user, while
	// Kubernetes-only state may be private. Rewriting routes must preserve both.
	for _, mode := range []os.FileMode{0644, 0600} {
		t.Run(mode.String(), func(t *testing.T) {
			if err := os.Chmod(path, mode); err != nil {
				t.Fatal(err)
			}
			if err := configureDevelopmentRouting(state, []string{"10.42.0.18/32"}, endpoint); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != mode {
				t.Fatalf("routing update changed reader permissions: got %o, want %o", info.Mode().Perm(), mode)
			}
		})
	}
}

func TestDevelopmentRoutingProxyCIDRsUseOnlyExactEnvoyAddresses(t *testing.T) {
	data := []byte(`{"items":[{"status":{"podIP":"10.42.0.18"}},{"status":{"podIP":"10.42.0.17"}},{"status":{"podIP":"10.42.0.18"}}]}`)

	trustedProxyCIDRs, err := developmentRoutingProxyCIDRs(data, "10.42.0.0/24")
	if err != nil {
		t.Fatal(err)
	}
	if len(trustedProxyCIDRs) != 2 || trustedProxyCIDRs[0] != "10.42.0.17/32" || trustedProxyCIDRs[1] != "10.42.0.18/32" {
		t.Fatalf("unexpected exact proxy CIDRs: %v", trustedProxyCIDRs)
	}
}

func TestDevelopmentCRDEstablishedWaitsForTheCondition(t *testing.T) {
	tests := []struct {
		name        string
		data        string
		established bool
	}{
		{name: "missing status", data: `{}`},
		{name: "missing conditions", data: `{"status":{}}`},
		{name: "unrelated condition", data: `{"status":{"conditions":[{"type":"NamesAccepted","status":"True"}]}}`},
		{name: "not established", data: `{"status":{"conditions":[{"type":"Established","status":"False"}]}}`},
		{name: "established", data: `{"status":{"conditions":[{"type":"Established","status":"True"}]}}`, established: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			established, err := developmentCRDEstablished([]byte(test.data))
			if err != nil {
				t.Fatal(err)
			}
			if established != test.established {
				t.Fatalf("established = %t, want %t", established, test.established)
			}
		})
	}
	if _, err := developmentCRDEstablished([]byte(`{"status":`)); err == nil {
		t.Fatal("invalid CustomResourceDefinition status was accepted")
	}
}

func TestRemoveDevelopmentGatewayAPICRDsPreservesOtherResources(t *testing.T) {
	// k3s owns the Gateway API CRDs, but the pinned controller manifest can
	// contain other CRDs and literal scripts that must reach kubectl intact.
	input := []byte(`apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gateways.gateway.networking.k8s.io
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: envoyproxies.gateway.envoyproxy.io
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: script
data:
  literal: |
    before
    ---
    after
`)
	output, err := removeDevelopmentGatewayAPICRDs(input)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(output, []byte("gateways.gateway.networking.k8s.io")) {
		t.Fatal("Gateway API CRD would replace the version owned by k3s")
	}
	decoder := yaml.NewDecoder(bytes.NewReader(output))
	var crd struct {
		Metadata struct {
			Name string `yaml:"name"`
		} `yaml:"metadata"`
	}
	if err := decoder.Decode(&crd); err != nil {
		t.Fatal(err)
	}
	if crd.Metadata.Name != "envoyproxies.gateway.envoyproxy.io" {
		t.Fatalf("non-Gateway CRD was not retained: %q", crd.Metadata.Name)
	}
	var config struct {
		Data map[string]string `yaml:"data"`
	}
	if err := decoder.Decode(&config); err != nil {
		t.Fatal(err)
	}
	if config.Data["literal"] != "before\n---\nafter\n" {
		t.Fatalf("literal content changed: %q", config.Data["literal"])
	}
}
