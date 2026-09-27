package occdev

import (
	"bytes"
	"testing"

	"go.yaml.in/yaml/v3"
)

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
