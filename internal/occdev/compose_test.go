package occdev

import (
	"path/filepath"
	"testing"
)

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
