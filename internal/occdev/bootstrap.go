package occdev

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

// Prepare once per owned setup attempt. Retain inputs for diagnosis; never regenerate on retry.
func (r *runner) prepareBootstrapCredentials(state *developmentState) error {
	passwordPath := filepath.Join(state.directory, "initial-admin-password")
	keyPath := filepath.Join(state.directory, "initial-admin-service-key")
	password := r.env["OPENCLAW_DEV_PASSWORD"]
	if password == "" {
		password = "openclaw-development-password"
		if state.DeploymentMode == "k3d" {
			password = rand.Text()
		}
	}
	// Match the initializer's single optional file terminator; password spaces are significant.
	if strings.HasSuffix(password, "\r\n") {
		password = strings.TrimSuffix(password, "\r\n")
	} else {
		password = strings.TrimSuffix(password, "\n")
	}
	if strings.ContainsAny(password, "\r\n\x00") {
		return fmt.Errorf("administrator password must not contain NUL or embedded line breaks")
	}
	if err := exclusiveWrite(passwordPath, []byte(password), 0600); err != nil {
		return err
	}
	material := make([]byte, 32)
	if _, err := rand.Read(material); err != nil {
		return err
	}
	key := "occ_" + base64.RawURLEncoding.EncodeToString(material)
	if err := exclusiveWrite(keyPath, []byte(key), 0600); err != nil {
		return err
	}
	data, err := json.Marshal(map[string]any{"data": map[string]string{"key": key}})
	if err != nil {
		return err
	}
	if err := exclusiveWrite(filepath.Join(state.directory, "bootstrap-client-key.json"), data, 0600); err != nil {
		return err
	}
	if state.DeploymentMode != "k3d" {
		for name, value := range map[string]string{"mount-admin-password": password, "mount-admin-service-key": key} {
			if err := exclusiveWrite(filepath.Join(state.directory, name), []byte(value), 0600); err != nil {
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
