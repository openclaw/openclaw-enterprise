package occdev

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/bootstrapcredentials"
	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

// Prepare once per owned setup attempt. Retain inputs for diagnosis; never regenerate on retry.
func (r *runner) prepareBootstrapCredentials(state *developmentState) error {
	password := r.env["OPENCLAW_DEV_PASSWORD"]
	if password == "" && state.DeploymentMode != "k3d" {
		password = "openclaw-development-password"
	}
	inputs, err := bootstrapcredentials.Prepare(state.directory, password)
	if err != nil {
		return err
	}
	passwordPath := inputs.PasswordPath
	keyPath := inputs.ServiceKeyPath
	if state.DeploymentMode != "k3d" {
		for name, source := range map[string]string{"mount-admin-password": passwordPath, "mount-admin-service-key": keyPath} {
			data, err := os.ReadFile(source)
			if err != nil {
				return err
			}
			if err := exclusiveWrite(filepath.Join(state.directory, name), data, 0600); err != nil {
				return err
			}
		}
		passwordPath = filepath.Join(state.directory, "mount-admin-password")
		keyPath = filepath.Join(state.directory, "mount-admin-service-key")
	}
	r.env["OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE"] = passwordPath
	r.env["OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE"] = keyPath
	return nil
}

func (r *runner) verifyBootstrapKey(ctx context.Context, state *developmentState, url string) (string, *occclient.Client, error) {
	source := filepath.Join(state.directory, "bootstrap-client-key.json")
	client, err := occclient.New(occclient.Config{URL: url, ServiceKeyFile: source, Timeout: 15 * time.Second, Context: ctx})
	if err != nil {
		return "", nil, err
	}
	installation, err := client.GetInstallation()
	if err != nil {
		return "", nil, fmt.Errorf("Installation authorization failed: %w", err)
	}
	record, ok := installation.(map[string]any)
	if !ok {
		return "", nil, fmt.Errorf("invalid Installation response")
	}
	id, ok := record["id"].(string)
	if !ok || id == "" {
		return "", nil, fmt.Errorf("invalid Installation ID")
	}
	// Bind later helpers to the Installation confirmed with this exact credential.
	state.InstallationID = id
	if err := rewriteState(state); err != nil {
		return "", nil, err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return "", nil, err
	}
	if err := exclusiveWrite(state.KeyPath, data, 0600); err != nil {
		return "", nil, err
	}
	return id, client, nil
}
