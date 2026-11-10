package occdev

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestValidateClusterNameExplainsTheRequiredPrefix(t *testing.T) {
	for _, name := range []string{"occ-dev-example", "occ-dev-0abc-1"} {
		if err := validateClusterName(name); err != nil {
			t.Fatalf("validateClusterName(%q) = %v", name, err)
		}
	}
	for _, name := range []string{"oce-dogfood", "occ-dev-", "occ-dev-Upper", "occ-dev-" + strings.Repeat("a", 56)} {
		err := validateClusterName(name)
		if err == nil {
			t.Fatalf("validateClusterName(%q) accepted an invalid name", name)
		}
		for _, want := range []string{"OCC_DEVELOPMENT_KUBERNETES_CLUSTER", `"` + name + `"`, "occ-dev-", "32"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("validateClusterName(%q) error %q does not mention %q", name, err, want)
			}
		}
	}
}

func TestNetworkEgressChoicePersistsThroughReload(t *testing.T) {
	for _, mode := range []string{"", "public", "restricted"} {
		t.Run("saved-"+mode, func(t *testing.T) {
			// A changed shell selection must not widen a previously saved installation.
			t.Setenv("OCC_DEVELOPMENT_NETWORK_EGRESS_MODE", "public")
			saved := map[string]any{
				"version": 3, "repository": "/repo", "computeDriver": "kubernetes", "sandboxDriver": "none", "deploymentMode": "k3d",
				"platformNamespace": "oce-system", "apiPort": 3000, "containerEngine": "docker", "cluster": "occ-dev-test",
				"dockerHost": "unix:///run/docker.sock", "keyPath": "/key.json", "keyOwned": false,
			}
			if mode != "" {
				saved["networkEgressMode"] = mode
			}
			directory := writePrivateState(t, saved)
			state, err := readState(directory)
			if err != nil {
				t.Fatal(err)
			}
			if err := rewriteState(state); err != nil {
				t.Fatal(err)
			}
			state, err = readState(directory)
			if err != nil {
				t.Fatal(err)
			}
			if err := writeInstallation(state, "runtime@"+profileTestDigest, nil, "", "", "10.42.0.1/32"); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(directory, "installation.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			var installation map[string]any
			if err := yaml.Unmarshal(data, &installation); err != nil {
				t.Fatal(err)
			}
			want := mode
			if want == "" {
				want = "restricted"
			}
			if installation["networkEgressMode"] != want {
				t.Fatalf("saved %q rendered as %v", mode, installation["networkEgressMode"])
			}
		})
	}
}

func TestNewNetworkEgressChoice(t *testing.T) {
	for _, tc := range []struct{ input, want string }{{"", "restricted"}, {"public", "public"}, {"restricted", "restricted"}} {
		t.Setenv("OCC_DEVELOPMENT_NETWORK_EGRESS_MODE", tc.input)
		got, err := newRunner(Options{}).networkEgressMode()
		if err != nil || got != tc.want {
			t.Fatalf("selection %q = %q, %v", tc.input, got, err)
		}
	}
	for _, controlPlane := range []string{"compose", "kubernetes"} {
		t.Setenv("OCC_DEVELOPMENT_NETWORK_EGRESS_MODE", "unrestricted")
		t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", controlPlane)
		directory := filepath.Join(t.TempDir(), "state")
		t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", directory)
		if err := Up(context.Background(), Options{}); err == nil || !strings.Contains(err.Error(), "OCC_DEVELOPMENT_NETWORK_EGRESS_MODE") {
			t.Fatalf("invalid selection accepted: %v", err)
		}
		if _, err := os.Stat(directory); !os.IsNotExist(err) {
			t.Fatalf("invalid selection created state: %v", err)
		}
	}
}

func TestPublicDevelopmentProfileRequiresAuthenticatedSupportedOpenShell(t *testing.T) {
	for _, key := range []string{"OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE", "OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE", "OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE", "OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION", "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []string{"OCC_DEVELOPMENT_NETWORK_EGRESS_MODE", "OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_SIGN_IN"} {
		t.Setenv(key, "")
	}
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "kubernetes")
	t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", "")
	t.Setenv("OCC_DEVELOPMENT_DATABASE_NAME", "openclaw_k8s_public")
	t.Setenv("OCC_DEVELOPMENT_NETWORK_EGRESS_MODE", "public")
	// Public mode selects the Kubernetes control plane in both CLI preflight and Up.
	if err := CheckDevelopmentProfile(); err != nil {
		t.Fatalf("public default database preflight: %v", err)
	}
	for _, tc := range []struct{ name, sandbox, controlPlane, message string }{
		{"explicit public mode with stock images", "", "", "bundled OpenShell 0.1.6 does not support public network egress"},
		{"direct secrets", "none", "kubernetes", "authenticated Credential Gateway delivery"},
		{"unauthenticated management", "openshell", "compose", "authenticated Credential Gateway delivery"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", tc.sandbox)
			t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", tc.controlPlane)
			directory := filepath.Join(t.TempDir(), "state")
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", directory)
			// Resolve the real startup path, but stop before creating a cluster or state.
			err := Up(context.Background(), Options{})
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("startup = %v, want %s", err, tc.message)
			}
			if _, err := os.Stat(directory); !os.IsNotExist(err) {
				t.Fatalf("unsupported public startup created state: %v", err)
			}
		})
	}
	t.Run("explicit stock Gateway and supervisor digests", func(t *testing.T) {
		t.Setenv("OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION", strings.Repeat("a", 40))
		t.Setenv("OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE", openShellGatewayImage)
		t.Setenv("OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE", openShellSandboxImage)
		t.Setenv("OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE", openShellSupervisorImage)
		directory := filepath.Join(t.TempDir(), "state")
		t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", directory)
		err := Up(context.Background(), Options{})
		if err == nil || !strings.Contains(err.Error(), "bundled OpenShell 0.1.6 does not support public network egress") {
			t.Fatalf("startup accepted the stock pair as a candidate: %v", err)
		}
		if _, err := os.Stat(directory); !os.IsNotExist(err) {
			t.Fatalf("unsupported public startup created state: %v", err)
		}
	})
}
