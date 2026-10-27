package occdev

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

const apiEndpointFixture = `{"metadata":{"name":"kubernetes","namespace":"default"},"subsets":[{"addresses":[{"ip":"172.22.0.3"}],"ports":[{"name":"https","protocol":"TCP","port":6443}]}]}`
const apiPolicyFixture = `{
 "metadata":{"name":"openclaw-enterprise-dependency-egress","namespace":"control","uid":"policy-uid","resourceVersion":"42","annotations":{"meta.helm.sh/release-name":"oce","meta.helm.sh/release-namespace":"control"}},
 "spec":{"podSelector":{"matchLabels":{"app.kubernetes.io/name":"openclaw-enterprise","app.kubernetes.io/instance":"oce"},"matchExpressions":[{"key":"app.kubernetes.io/component","operator":"In","values":["api","worker","initialization"]}]},"policyTypes":["Egress"],"egress":[
  {"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}},"podSelector":{"matchLabels":{"k8s-app":"kube-dns"}}}],"ports":[{"port":53,"protocol":"UDP"},{"port":53,"protocol":"TCP"}]},
  {"to":[{"ipBlock":{"cidr":"10.43.1.20/32"}}],"ports":[{"port":5432,"protocol":"TCP"}]},
  {"to":[{"ipBlock":{"cidr":"172.22.0.2/32"}}],"ports":[{"port":6443,"protocol":"TCP"}]}
 ]}}
`

func apiEgressTestOptions() K3dAPIEgressOptions {
	return K3dAPIEgressOptions{Namespace: "control", NamespaceUID: "namespace-uid", Release: "oce", APIPort: 6443}
}

func TestAPIEgressReplacesStaleHostWithoutChangingOtherPermissions(t *testing.T) {
	plan, err := planAPIEgress([]byte(apiEndpointFixture), []byte(apiPolicyFixture), map[string]bool{"172.22.0.3": true}, apiEgressTestOptions())
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Changed || !slices.Equal(plan.Before, []string{"172.22.0.2/32"}) || !slices.Equal(plan.After, []string{"172.22.0.3/32"}) {
		t.Fatalf("unexpected endpoint transition: %+v", plan)
	}
	// The patch must replace, not union, destinations and must protect against
	// namespace-policy replacement and concurrent Helm/operator writes.
	expected := `[{"op":"test","path":"/metadata/uid","value":"policy-uid"},{"op":"test","path":"/metadata/resourceVersion","value":"42"},{"op":"replace","path":"/spec/egress/2/to","value":[{"ipBlock":{"cidr":"172.22.0.3/32"}}]}]`
	actual, _ := json.Marshal(plan.Patch)
	if string(actual) != expected {
		t.Fatalf("patch changes permissions outside the API destinations: %s", actual)
	}
	current := strings.ReplaceAll(apiPolicyFixture, "172.22.0.2/32", "172.22.0.3/32")
	unchanged, err := planAPIEgress([]byte(apiEndpointFixture), []byte(current), map[string]bool{"172.22.0.3": true}, apiEgressTestOptions())
	if err != nil || unchanged.Changed {
		t.Fatalf("matching endpoints must not generate a write: %+v %v", unchanged, err)
	}
}

func TestAPIEgressRefusesUntrustedEndpointsOrExpandedPolicies(t *testing.T) {
	for _, test := range []struct{ name, endpoint, policy string }{
		{"foreign endpoint", strings.ReplaceAll(apiEndpointFixture, "172.22.0.3", "192.0.2.1"), apiPolicyFixture},
		{"no ready endpoint", strings.ReplaceAll(apiEndpointFixture, `"addresses":[{"ip":"172.22.0.3"}]`, `"addresses":[]`), apiPolicyFixture},
		{"different API port", strings.ReplaceAll(apiEndpointFixture, "6443", "443"), apiPolicyFixture},
		{"foreign release", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, `"meta.helm.sh/release-name":"oce"`, `"meta.helm.sh/release-name":"other"`)},
		{"tenant selector", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, `"app.kubernetes.io/name":"openclaw-enterprise"`, `"app.kubernetes.io/name":"tenant-agent"`)},
		{"extra component", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, `"worker","initialization"`, `"worker","initialization","agent"`)},
		{"broad existing network", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, "172.22.0.2/32", "172.22.0.0/16")},
		{"peer with exception", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, `"cidr":"172.22.0.2/32"`, `"cidr":"172.22.0.2/32","except":["172.22.0.2/32"]`)},
		{"mixed API port rule", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, `{"port":6443,"protocol":"TCP"}`, `{"port":6443,"protocol":"TCP"},{"port":443,"protocol":"TCP"}`)},
		{"API range", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, `"port":6443`, `"port":6443,"endPort":6500`)},
		{"range overlaps API", apiEndpointFixture, strings.ReplaceAll(apiPolicyFixture, `"port":5432`, `"port":5432,"endPort":6500`)},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan, err := planAPIEgress([]byte(test.endpoint), []byte(test.policy), map[string]bool{"172.22.0.3": true}, apiEgressTestOptions())
			if err == nil || len(plan.Patch) != 0 {
				t.Fatalf("unsafe input produced a patch: %+v %v", plan, err)
			}
		})
	}
}

func TestAPIEgressTracksOnlyReadyOwnedControlPlaneServers(t *testing.T) {
	endpoint := strings.ReplaceAll(apiEndpointFixture, `{"ip":"172.22.0.3"}`, `{"ip":"172.22.0.4"},{"ip":"172.22.0.3"},{"ip":"172.22.0.3"}`)
	plan, err := planAPIEgress([]byte(endpoint), []byte(apiPolicyFixture), map[string]bool{"172.22.0.3": true, "172.22.0.4": true, "172.22.0.5": true}, apiEgressTestOptions())
	if err != nil || !slices.Equal(plan.After, []string{"172.22.0.3/32", "172.22.0.4/32"}) {
		t.Fatalf("must admit exactly ready API server hosts: %+v %v", plan, err)
	}
}
