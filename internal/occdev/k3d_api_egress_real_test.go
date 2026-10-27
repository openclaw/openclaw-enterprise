package occdev

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// First Agent Smoke selects this real Docker/Kubernetes test on its provisioned
// cluster, then exercises installed recovery before Agent stop/start and chat.
// This case owns an empty namespace and tests final-write ownership conflicts.
func TestK3dAPIEgressReal(t *testing.T) {
	cluster := os.Getenv("OCC_TEST_K3D_API_EGRESS_CLUSTER")
	if cluster == "" {
		t.Skip("requires an explicitly selected disposable local k3d cluster")
	}
	dockerContext := os.Getenv("OCC_TEST_K3D_API_EGRESS_DOCKER_CONTEXT")
	if dockerContext == "" {
		t.Fatal("OCC_TEST_K3D_API_EGRESS_DOCKER_CONTEXT is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	namespace := fmt.Sprintf("oce-egress-test-%d", time.Now().UnixNano())
	kube := func(input string, args ...string) []byte {
		t.Helper()
		prefix := []string{"--context", dockerContext, "exec", "-i", "k3d-" + cluster + "-server-0", "kubectl", "--request-timeout=8s"}
		cmd := exec.CommandContext(ctx, "docker", append(prefix, args...)...)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("Kubernetes fixture operation failed: %v", err)
		}
		return out
	}
	created := kube("", "create", "namespace", namespace, "-o", "json")
	defer kube("", "delete", "namespace", namespace, "--wait=false")
	var ns struct{ Metadata struct{ UID string } }
	if err := json.Unmarshal(created, &ns); err != nil {
		t.Fatal(err)
	}
	var policy map[string]any
	if err := json.Unmarshal([]byte(apiPolicyFixture), &policy); err != nil {
		t.Fatal(err)
	}
	metadata := policy["metadata"].(map[string]any)
	delete(metadata, "uid")
	delete(metadata, "resourceVersion")
	metadata["namespace"] = namespace
	metadata["annotations"].(map[string]any)["meta.helm.sh/release-namespace"] = namespace
	policy["apiVersion"], policy["kind"] = "networking.k8s.io/v1", "NetworkPolicy"
	// Choose an exact stale destination after inspecting the real endpoint. The
	// replacement case must remain valid for every Docker-assigned node subnet.
	endpointJSON := kube("", "-n", "default", "get", "endpoints", "kubernetes", "-o", "json")
	var endpoint struct {
		Subsets []struct{ Addresses []struct{ IP string } }
	}
	if err := json.Unmarshal(endpointJSON, &endpoint); err != nil {
		t.Fatal(err)
	}
	serverIPs := map[string]bool{}
	for _, subset := range endpoint.Subsets {
		for _, address := range subset.Addresses {
			serverIPs[address.IP] = true
		}
	}
	stale := "192.0.2.1"
	for serverIPs[stale] {
		stale = "192.0.2.2"
		if serverIPs[stale] {
			t.Fatal("documentation addresses unexpectedly both used by cluster")
		}
	}
	policy["spec"].(map[string]any)["egress"].([]any)[2].(map[string]any)["to"] = []any{map[string]any{"ipBlock": map[string]any{"cidr": stale + "/32"}}}
	data, _ := json.Marshal(policy)
	kube(string(data), "create", "-f", "-")
	get := func() map[string]any {
		var value map[string]any
		if err := json.Unmarshal(kube("", "-n", namespace, "get", "networkpolicy", apiEgressPolicy, "-o", "json"), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := get()
	var output bytes.Buffer
	opts := K3dAPIEgressOptions{DockerContext: dockerContext, Cluster: cluster, Namespace: namespace, NamespaceUID: ns.Metadata.UID, Release: "oce", APIPort: 6443, Out: &output}
	if err := ReconcileK3dAPIEgress(ctx, opts); err != nil {
		t.Fatal(err)
	}
	if get()["metadata"].(map[string]any)["resourceVersion"] != before["metadata"].(map[string]any)["resourceVersion"] {
		t.Fatal("preview wrote the policy")
	}
	// A stale namespace handle must not adopt even a correctly named policy.
	opts.Apply = true
	opts.NamespaceUID = "foreign-namespace"
	if err := ReconcileK3dAPIEgress(ctx, opts); err == nil {
		t.Fatal("foreign namespace identity was accepted")
	}
	if get()["metadata"].(map[string]any)["resourceVersion"] != before["metadata"].(map[string]any)["resourceVersion"] {
		t.Fatal("refused operation wrote the policy")
	}
	opts.NamespaceUID = ns.Metadata.UID
	opts.Release = "foreign-release"
	if err := ReconcileK3dAPIEgress(ctx, opts); err == nil {
		t.Fatal("foreign Helm release was accepted")
	}
	if get()["metadata"].(map[string]any)["resourceVersion"] != before["metadata"].(map[string]any)["resourceVersion"] {
		t.Fatal("foreign release refusal wrote the policy")
	}
	opts.Release = "oce"
	// Exercise the production planner's exact JSON Patch at the real API after
	// ownership changes. A preflight refusal alone cannot prove write fencing.
	stalePlan := func() []byte {
		value, _ := json.Marshal(get())
		plan, err := planAPIEgress(endpointJSON, value, serverIPs, opts)
		if err != nil {
			t.Fatal(err)
		}
		patch, err := json.Marshal(plan.Patch)
		if err != nil {
			t.Fatal(err)
		}
		return patch
	}
	refusePatch := func(patch []byte) {
		t.Helper()
		current := get()
		cmd := exec.CommandContext(ctx, "docker", "--context", dockerContext, "exec", "-i", "k3d-"+cluster+"-server-0", "kubectl", "--request-timeout=8s", "-n", namespace, "patch", "networkpolicy", apiEgressPolicy, "--type=json", "--patch-file=/dev/stdin")
		cmd.Stdin = bytes.NewReader(patch)
		if err := cmd.Run(); err == nil {
			t.Fatal("stale ownership patch reached the policy")
		}
		if get()["metadata"].(map[string]any)["resourceVersion"] != current["metadata"].(map[string]any)["resourceVersion"] {
			t.Fatal("refused stale patch changed the policy")
		}
	}
	patch := stalePlan()
	kube("", "-n", namespace, "annotate", "networkpolicy", apiEgressPolicy, "meta.helm.sh/release-name=foreign-release", "--overwrite")
	refusePatch(patch)
	if err := ReconcileK3dAPIEgress(ctx, opts); err == nil {
		t.Fatal("changed Helm owner was accepted")
	}
	kube("", "-n", namespace, "annotate", "networkpolicy", apiEgressPolicy, "meta.helm.sh/release-name=oce", "--overwrite")
	patch = stalePlan()
	kube("", "-n", namespace, "delete", "networkpolicy", apiEgressPolicy)
	kube(string(data), "create", "-f", "-")
	refusePatch(patch)
	before = get()
	if err := ReconcileK3dAPIEgress(ctx, opts); err != nil {
		t.Fatal(err)
	}
	after := get()
	var event struct {
		Applied, Changed bool
		Before, After    []string
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &event); err != nil {
		t.Fatal(err)
	}
	if !event.Applied || !event.Changed || len(event.After) == 0 {
		t.Fatalf("expected a real endpoint replacement: %+v", event)
	}
	// Compare the entire spec except the one destination field. This catches
	// changes to namespace/Pod selectors, DNS, database, API port or policy type.
	beforeSpec := before["spec"].(map[string]any)
	afterSpec := after["spec"].(map[string]any)
	beforeSpec["egress"].([]any)[2].(map[string]any)["to"] = afterSpec["egress"].([]any)[2].(map[string]any)["to"]
	b, _ := json.Marshal(beforeSpec)
	a, _ := json.Marshal(afterSpec)
	if !bytes.Equal(a, b) {
		t.Fatal("reconciliation changed non-API-destination policy")
	}
	if err := ReconcileK3dAPIEgress(ctx, opts); err != nil {
		t.Fatal(err)
	}
	if get()["metadata"].(map[string]any)["resourceVersion"] != after["metadata"].(map[string]any)["resourceVersion"] {
		t.Fatal("unchanged endpoints caused another write")
	}
	t.Logf("real API replacement passed; namespace/release refusal, changed owner/object conflict, dry-run and no-op passed")
	t.Run("namespace recreation during policy acquisition", func(t *testing.T) {
		// Delay the real policy GET with an installation replacement. Every read
		// and write still goes to Kubernetes; the wrapper only controls timing.
		dockerPath, err := exec.LookPath("docker")
		if err != nil {
			t.Fatal(err)
		}
		directory := t.TempDir()
		policyPath := filepath.Join(directory, "policy.json")
		replacementPath := filepath.Join(directory, "replacement.json")
		if err := os.WriteFile(policyPath, data, 0600); err != nil {
			t.Fatal(err)
		}
		for key, value := range map[string]string{
			"EGRESS_TEST_DOCKER": dockerPath, "EGRESS_TEST_CONTEXT": dockerContext,
			"EGRESS_TEST_NODE": "k3d-" + cluster + "-server-0", "EGRESS_TEST_NAMESPACE": namespace,
			"EGRESS_TEST_POLICY": policyPath, "EGRESS_TEST_REPLACEMENT": replacementPath,
		} {
			t.Setenv(key, value)
		}
		wrapper := `#!/bin/sh
set -eu
case "$*" in
  *" -n $EGRESS_TEST_NAMESPACE get networkpolicy openclaw-enterprise-dependency-egress -o json")
    if [ ! -f "$EGRESS_TEST_REPLACEMENT" ]; then
      kube() { "$EGRESS_TEST_DOCKER" --context "$EGRESS_TEST_CONTEXT" exec -i "$EGRESS_TEST_NODE" kubectl --request-timeout=8s "$@"; }
      kube delete namespace "$EGRESS_TEST_NAMESPACE" --wait=true >/dev/null
      kube create namespace "$EGRESS_TEST_NAMESPACE" >/dev/null
      kube create -f - -o json <"$EGRESS_TEST_POLICY" >"$EGRESS_TEST_REPLACEMENT"
    fi
    ;;
esac
exec "$EGRESS_TEST_DOCKER" "$@"
`
		if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(wrapper), 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
		if err := ReconcileK3dAPIEgress(ctx, opts); err == nil {
			t.Fatal("recreated namespace was adopted using the previous installation UID")
		}
		replacement, err := os.ReadFile(replacementPath)
		if err != nil {
			t.Fatal("namespace replacement did not execute:", err)
		}
		var installed map[string]any
		if err := json.Unmarshal(replacement, &installed); err != nil {
			t.Fatal(err)
		}
		if get()["metadata"].(map[string]any)["resourceVersion"] != installed["metadata"].(map[string]any)["resourceVersion"] {
			t.Fatal("stale installation authority changed the replacement policy")
		}
		t.Log("recreated namespace refused; replacement policy resourceVersion unchanged")
	})
}
