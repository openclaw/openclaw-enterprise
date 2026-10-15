package occdev

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDevelopmentNamespaceLengthPreflight(t *testing.T) {
	for _, driver := range []string{"none", "openshell"} {
		t.Run(driver, func(t *testing.T) {
			for _, length := range []int{63, 64, 200} {
				name := strings.Repeat("a", length)
				parent, err := filepath.EvalSymlinks(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				directory := filepath.Join(parent, "state")
				t.Setenv("PATH", t.TempDir())
				t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", "kubernetes")
				t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", driver)
				t.Setenv("OCC_DEVELOPMENT_KUBERNETES_NAMESPACE", name)
				t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", directory)
				t.Setenv("OCC_DEVELOPMENT_KUBERNETES_CLUSTER", "occ-dev-proof")
				t.Setenv("OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "")
				t.Setenv("OCC_DEVELOPMENT_REPOSITORY_IMAGE", "")
				t.Setenv("OCC_DEVELOPMENT_CONTROLLER_IMAGE", "")
				t.Setenv("OCC_KUBERNETES_RUNTIME_IMAGE", "")
				t.Setenv("OPENCLAW_DEV_PORT", "3000")
				t.Setenv("OCC_DEVELOPMENT_KUBERNETES_API_PORT", "6443")
				t.Setenv("OCC_DEVELOPMENT_BROWSER_PORT", "8443")
				err = Up(context.Background(), Options{Repository: t.TempDir()})
				if length == 63 {
					if err == nil || !strings.Contains(err.Error(), "k3d is required on PATH") {
						t.Fatalf("valid boundary rejected: %v", err)
					}
				} else if err == nil || !strings.Contains(err.Error(), "invalid OCC_DEVELOPMENT_KUBERNETES_NAMESPACE") {
					t.Fatalf("length %d passed Namespace preflight: %v", length, err)
				}
				if _, err := os.Stat(directory); !os.IsNotExist(err) {
					t.Fatalf("state created before rejection: %v", err)
				}
			}
		})
	}
}
