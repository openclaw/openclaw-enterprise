package occdev

import (
	"encoding/json/v2"
	"fmt"
	"path/filepath"
	"regexp"
)

var developmentDatabaseName = regexp.MustCompile(`^openclaw_k8s_[a-z0-9_]+$`)

// CheckDevelopmentProfile validates protected egress and its related selectors
// before Compute dispatch, including callers that otherwise bypass Up.
func CheckDevelopmentProfile() error {
	r := newRunner(Options{})
	controlPlane := r.setting("OCC_DEVELOPMENT_CONTROL_PLANE", "compose")
	if err := r.protectedEgressSelection(); err != nil {
		return err
	}
	if _, err := r.selectedDevelopmentDatabase(controlPlane); err != nil {
		return err
	}
	if _, selected := r.env["OCC_DEVELOPMENT_DATABASE_NAME"]; selected && r.env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "kubernetes" {
		return fmt.Errorf("OCC_DEVELOPMENT_DATABASE_NAME requires Kubernetes Compute")
	}
	return nil
}

func (r *runner) protectedEgressSelection() error {
	value := r.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"]
	if value != "" && value != "0" && value != "1" {
		return fmt.Errorf("OCC_DEVELOPMENT_PROTECTED_EGRESS must be unset, empty, or set to 0")
	}
	if _, selected := r.env["OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"]; selected {
		return fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP is retired; remove this setting")
	}
	if value == "1" {
		return fmt.Errorf("OCC_DEVELOPMENT_PROTECTED_EGRESS=1 is retired; unset it or set it to 0 for ordinary development. This does not convert an existing installation; use occ dev down for cleanup.")
	}
	return nil
}

func (r *runner) selectedDevelopmentDatabase(controlPlane string) (string, error) {
	name, selected := r.env["OCC_DEVELOPMENT_DATABASE_NAME"]
	if !selected {
		return "openclaw_enterprise", nil
	}
	if controlPlane != "kubernetes" || len(name) > 63 || !developmentDatabaseName.MatchString(name) {
		return "", fmt.Errorf("OCC_DEVELOPMENT_DATABASE_NAME requires Kubernetes control plane and an openclaw_k8s_ name of at most 63 lowercase letters, digits or underscores")
	}
	return name, nil
}

func developmentAuthenticatedOpenShellValues() map[string]any {
	return map[string]any{
		"pkiInitJob": map[string]any{"enabled": true},
		"server": map[string]any{
			"disableTls": false,
			"auth":       map[string]any{"allowUnauthenticatedUsers": false},
			"tls":        map[string]any{"enableMtls": true},
		},
		"gatewayConfig": map[string]any{"openshell.supervisor.middleware": []any{}},
	}
}

func (r *runner) writeOpenShellGatewayValues(state *developmentState) (string, error) {
	values := developmentAuthenticatedOpenShellValues()
	data, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	path := filepath.Join(state.directory, "openshell-gateway-values.json")
	return path, exclusiveWrite(path, data, 0600)
}
