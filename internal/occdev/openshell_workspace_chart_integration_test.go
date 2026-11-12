//go:build openshell_chart_integration

package occdev

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"go.yaml.in/yaml/v3"
)

// Use the same released chart pair and values as the launcher. The quickstart
// resource list is compared to Helm output independently of the Driver fixture.
func TestOpenShellPackagedWorkspaceResources(t *testing.T) {
	directory := os.Getenv("OCC_TEST_OPENSHELL_STOCK_CHART_DIRECTORY")
	if directory == "" {
		t.Fatal("set OCC_TEST_OPENSHELL_STOCK_CHART_DIRECTORY to the packaged stock OpenShell 0.1.8 charts")
	}
	gateway := filepath.Join(directory, "helm-chart-0.1.8.tgz")
	workspace := filepath.Join(directory, "openshell-workspace-0.1.8.tgz")
	for _, chart := range []string{gateway, workspace} {
		data, err := exec.Command("helm", "show", "chart", chart).Output()
		if err != nil {
			t.Fatal(err)
		}
		var metadata struct {
			Version    string `yaml:"version"`
			AppVersion string `yaml:"appVersion"`
		}
		if err := yaml.Unmarshal(data, &metadata); err != nil {
			t.Fatal(err)
		}
		if metadata.Version != "0.1.8" || metadata.AppVersion != "0.1.8" {
			t.Fatalf("expected the stock 0.1.8 chart, got %+v", metadata)
		}
	}
	r := newRunner(Options{})
	actual, err := r.renderOpenShellWorkspaceResources(context.Background(), workspace, "oce-system")
	if err != nil {
		t.Fatal(err)
	}
	document, err := exec.Command("jq", "-n", "--argjson", "cluster", "{}", "--argjson", "proxyCidrs", "[]",
		"--arg", "runtime", "", "--arg", "openshellIP", "", "--arg", "hostname", "", "--arg", "storageClass", "",
		"-f", "../../docs/snippets/openshell-quickstart/kubernetes/installation.jq").Output()
	if err != nil {
		t.Fatal(err)
	}
	var want struct {
		Drivers struct {
			Sandbox struct {
				Configuration struct {
					Gateway struct {
						OperatorWorkspaceResources []any
					}
				}
			}
		}
	}
	if err := json.Unmarshal(document, &want); err != nil {
		t.Fatal(err)
	}
	expected := want.Drivers.Sandbox.Configuration.Gateway.OperatorWorkspaceResources
	// Compare normalized resources by kind. Helm's document order is immaterial.
	byKind := func(resources []any) map[string]any {
		result := make(map[string]any)
		for _, item := range resources {
			resource := item.(map[string]any)
			result[resource["kind"].(string)] = resource
		}
		return result
	}
	encoded, err := json.Marshal(byKind(actual))
	if err != nil {
		t.Fatal(err)
	}
	var normalized map[string]any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		t.Fatal(err)
	}
	if len(actual) != len(expected) || !reflect.DeepEqual(normalized, byKind(expected)) {
		t.Fatalf("packaged Workspace chart differs from quickstart configuration:\n%s", encoded)
	}
}
