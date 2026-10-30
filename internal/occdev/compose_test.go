package occdev

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestPodmanComposeArgsPreservesFileSelection(t *testing.T) {
	// Podman can interpret the h in an attached path as help, even for down.
	// A split file value starting with -f must not be normalized a second time.
	args := []string{
		"-fpath with spaces.yaml", "-f=next.yaml", "-f-dash.yaml", "-f==equals.yaml",
		"--file", "-first.yaml", "--file=last.yaml",
	}
	want := []string{
		"--file=path with spaces.yaml", "--file=next.yaml", "--file=-dash.yaml", "--file==equals.yaml",
		"--file", "-first.yaml", "--file=last.yaml", "-f", "compose.podman.yaml",
	}
	if got, err := podmanComposeArgs(args, "must-not-select.yaml", ""); err != nil || !slices.Equal(got, want) {
		t.Fatalf("Podman Compose arguments = %q, error %v; want %q", got, err, want)
	}
}

func TestPodmanComposeFileValues(t *testing.T) {
	for _, args := range [][]string{{"-f="}, {"-f", ""}, {"--file"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			got, err := podmanComposeArgs(args, "fallback.yaml", "")
			if err == nil || !strings.Contains(err.Error(), "--file requires a Compose file path") || got != nil {
				t.Fatalf("arguments = %q, error %v; want no arguments and a missing file error", got, err)
			}
		})
	}
	for _, tc := range []struct {
		name             string
		args             []string
		files, separator string
		want             []string
	}{
		{"split values", []string{"-f", "-first.yaml", "--file", "=literal.yaml", "--project-name", "with spaces"}, "ignored.yaml", "", []string{"-f", "-first.yaml", "--file", "=literal.yaml", "--project-name", "with spaces", "-f", "compose.podman.yaml"}},
		{"environment", []string{"--project-name", "example"}, "first.yaml|path with spaces.yaml", "|", []string{"--project-name", "example", "-f", "first.yaml", "-f", "path with spaces.yaml", "-f", "compose.podman.yaml"}},
		{"selected socket override", []string{"-f=compose.yaml", "-f=compose.podman.yaml"}, "ignored.yaml", "", []string{"--file=compose.yaml", "--file=compose.podman.yaml"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := podmanComposeArgs(tc.args, tc.files, tc.separator)
			if err != nil || !slices.Equal(got, tc.want) {
				t.Fatalf("arguments = %q, error %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestAddComposeGatewayRoutingProjectsTrustIntoControlPlane(t *testing.T) {
	state := &developmentState{directory: "/private/development-state"}
	rendered := map[string]any{
		"services": map[string]any{
			"controller": map[string]any{
				"environment": map[string]any{"NODE_ENV": "development"},
				"volumes":     []any{},
			},
			"worker-kubernetes": map[string]any{
				"environment": map[string]any{"NODE_ENV": "development"},
				"volumes":     []any{},
			},
			"postgres": map[string]any{"environment": map[string]any{}},
		},
	}
	if err := addComposeGatewayRouting(rendered, state); err != nil {
		t.Fatal(err)
	}
	services := rendered["services"].(map[string]any)
	for _, name := range []string{"controller", "worker-kubernetes"} {
		service := services[name].(map[string]any)
		environment := service["environment"].(map[string]any)
		if environment["OCC_GATEWAY_API_KEY_PATH"] != developmentGatewayAPIKeyMount ||
			environment["NODE_EXTRA_CA_CERTS"] != developmentGatewayCAMount {
			t.Fatalf("%s does not receive the private route inputs: %v", name, environment)
		}
		volumes := service["volumes"].([]any)
		if len(volumes) != 2 {
			t.Fatalf("%s has unexpected private route volumes: %v", name, volumes)
		}
		for index, expected := range []struct{ source, target string }{
			{filepath.Join(state.directory, "gateway-api-key"), developmentGatewayAPIKeyMount},
			{filepath.Join(state.directory, "gateway-ca.crt"), developmentGatewayCAMount},
		} {
			volume := volumes[index].(map[string]any)
			if volume["source"] != expected.source || volume["target"] != expected.target || volume["read_only"] != true {
				t.Fatalf("%s has unexpected private route volume: %v", name, volume)
			}
		}
	}
	postgres := services["postgres"].(map[string]any)
	if _, found := postgres["volumes"]; found {
		t.Fatal("the database must not receive private Gateway material")
	}
}

// An external OpenShell gateway selection has no in-cluster gateway key or CA to
// mount; only the optional external CA bundle reaches the control-plane services.
func TestComposeExternalOpenShellMountsOnlyTheSelectedCA(t *testing.T) {
	state := &developmentState{directory: "/private/development-state", openShellExternal: &externalOpenShell{}}
	rendered := map[string]any{
		"services": map[string]any{
			"controller":        map[string]any{"environment": map[string]any{"NODE_ENV": "development"}, "volumes": []any{}},
			"worker-kubernetes": map[string]any{"environment": map[string]any{"NODE_ENV": "development"}, "volumes": []any{}},
		},
	}
	if err := addComposeExternalOpenShell(rendered, state); err != nil {
		t.Fatal(err)
	}
	if len(rendered["services"].(map[string]any)["controller"].(map[string]any)["volumes"].([]any)) != 0 {
		t.Fatal("without a CA selection nothing is mounted")
	}
	state.openShellExternal.caPath = "/secure/openshell-ca.crt"
	if err := addComposeExternalOpenShell(rendered, state); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"controller", "worker-kubernetes"} {
		service := rendered["services"].(map[string]any)[name].(map[string]any)
		environment := service["environment"].(map[string]any)
		if environment["NODE_EXTRA_CA_CERTS"] != openShellExternalCAContainerPath {
			t.Fatalf("%s does not trust the external CA: %v", name, environment)
		}
		volumes := service["volumes"].([]any)
		if len(volumes) != 1 {
			t.Fatalf("%s has unexpected volumes: %v", name, volumes)
		}
		volume := volumes[0].(map[string]any)
		if volume["source"] != filepath.Join(state.directory, "openshell-ca.crt") || volume["target"] != openShellExternalCAContainerPath || volume["read_only"] != true {
			t.Fatalf("%s has an unexpected CA volume: %v", name, volume)
		}
	}
}

func TestComposeNativeAdminPublishesOnlyTheOwnedHTTPSOrigin(t *testing.T) {
	state := &developmentState{
		Cluster:       "occ-dev-example",
		BrowserPort:   8443,
		BrowserOrigin: "https://console.occ-dev-example.oce.localhost:8443",
	}
	controllerEnvironment := map[string]any{
		"OCC_AUTH_BASE_URL":              state.BrowserOrigin,
		"OCC_AGENT_NATIVE_ADMIN_ENABLED": "true",
		"OCC_AGENT_NATIVE_ADMIN_DOMAIN":  "agents.occ-dev-example.oce.localhost",
		"OCC_AUTH_COOKIE_DOMAIN":         "occ-dev-example.oce.localhost",
		"OCC_GATEWAY_API_KEY_PATH":       developmentGatewayAPIKeyMount,
		"NODE_EXTRA_CA_CERTS":            developmentGatewayCAMount,
	}
	rendered := map[string]any{"services": map[string]any{
		"controller":    map[string]any{"environment": controllerEnvironment},
		"browser-proxy": map[string]any{"ports": []any{"127.0.0.1:8443:8443/tcp"}},
	}}

	if err := validateComposeNativeAdmin(rendered, state); err != nil {
		t.Fatal(err)
	}
	rendered["services"].(map[string]any)["browser-proxy"].(map[string]any)["ports"] = []any{"0.0.0.0:8443:8443/tcp"}
	if err := validateComposeNativeAdmin(rendered, state); err == nil || !strings.Contains(err.Error(), "only on 127.0.0.1") {
		t.Fatalf("public native admin publication was not rejected: %v", err)
	}
}
