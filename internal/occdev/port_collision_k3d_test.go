package occdev

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestK3dStartupRejectsConflictingHostPortsBeforeSetup(t *testing.T) {
	for _, tc := range []struct{ name, mode, api, kubernetes, browser string }{
		{"OpenShell API collision", "openshell", "6443", "6443", "8443"},
		{"no sandbox API collision", "none", "6443", "6443", "8443"},
		{"browser and development API collision", "none", "3000", "6443", "3000"},
		{"browser and Kubernetes API collision", "none", "3000", "6443", "6443"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, key := range []string{"OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE"} {
				t.Setenv(key, "")
			}
			t.Setenv("OPENCLAW_DEV_PORT", tc.api)
			t.Setenv("OCC_DEVELOPMENT_KUBERNETES_API_PORT", tc.kubernetes)
			t.Setenv("OCC_DEVELOPMENT_BROWSER_PORT", tc.browser)
			parent, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			state := filepath.Join(parent, "state")
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state)
			// No external tools can run: invalid ports must be rejected first.
			t.Setenv("PATH", t.TempDir())
			err = upK3d(context.Background(), Options{Repository: parent}, tc.mode)
			if err == nil || !strings.Contains(err.Error(), "ports must differ") {
				t.Fatalf("expected port rejection before setup, got %v", err)
			}
			if _, err := os.Stat(state); !os.IsNotExist(err) {
				t.Fatalf("startup touched its state directory: %v", err)
			}
		})
	}
}
