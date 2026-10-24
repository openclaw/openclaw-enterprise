package occdev

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestK3dStartupRejectsConflictingHostPortsBeforeSetup(t *testing.T) {
	for _, tc := range []struct{ name, plane, mode, api, kubernetes, browser string }{
		{"OpenShell API collision", "kubernetes", "openshell", "6443", "6443", "8443"},
		{"no sandbox API collision", "kubernetes", "none", "6443", "6443", "8443"},
		{"browser and development API collision", "kubernetes", "none", "3000", "6443", "3000"},
		{"browser and Kubernetes API collision", "kubernetes", "none", "3000", "6443", "6443"},
		// The Compose control plane publishes the controller API on the host too.
		{"Compose plane API collision", "compose", "none", "3000", "3000", "8443"},
		{"Compose plane OpenShell API collision", "compose", "openshell", "6443", "6443", "8443"},
		{"Compose plane existing browser and Kubernetes API check", "compose", "openshell", "3000", "6443", "6443"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, key := range []string{"OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE", developmentImageRegistrySetting} {
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
			if tc.plane == "kubernetes" {
				err = upK3d(context.Background(), Options{Repository: parent}, tc.mode, nil, nil)
			} else {
				t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", tc.plane)
				t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", tc.mode)
				err = Up(context.Background(), Options{Repository: parent})
			}
			if err == nil || !strings.Contains(err.Error(), "ports must differ") {
				t.Fatalf("expected port rejection before setup, got %v", err)
			}
			if _, err := os.Stat(state); !os.IsNotExist(err) {
				t.Fatalf("startup touched its state directory: %v", err)
			}
		})
	}
}

func TestComposeKubernetesStartupRejectsRenderedAPIPortCollisionBeforeSetup(t *testing.T) {
	for _, tc := range []struct{ name, shellAPI, rendered, kubernetes string }{
		// A Compose file or --env-file published the API on a port the shell did not name.
		{"env file moved the API port", "3000", "6443", "6443"},
		// No shell value: .env may still move the port, so the rendered default decides.
		{"default API port", "", "3000", "3000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			composeAPIPortCollision(t, tc.shellAPI, tc.rendered, tc.kubernetes)
		})
	}
}

func TestComposeKubernetesStartupLetsAnEnvFileMoveTheDefaultAPIPort(t *testing.T) {
	// .env.example sets OPENCLAW_DEV_PORT; a copied .env that moves it off the
	// Kubernetes API port must not be refused from the shell default alone.
	commands := composeAPIPortCollisionFixture(t, "", "4000", "3000")
	err := Up(context.Background(), Options{Repository: os.Getenv("OCC_TEST_REPOSITORY")})
	if err == nil || strings.Contains(err.Error(), "ports must differ") {
		t.Fatalf("expected startup past the port checks, got %v", err)
	}
	if !composeConfigRan(commands()) {
		t.Fatalf("startup stopped before rendering Compose: %v", err)
	}
}

func composeConfigRan(commands []string) bool {
	for _, command := range commands {
		if strings.HasPrefix(command, "docker compose --project-name ") && strings.HasSuffix(command, " config") {
			return true
		}
	}
	return false
}

func composeAPIPortCollision(t *testing.T, shellAPI, renderedAPI, kubernetes string) {
	commands := composeAPIPortCollisionFixture(t, shellAPI, renderedAPI, kubernetes)
	state := os.Getenv("OCC_DEVELOPMENT_STATE_DIRECTORY")
	err := Up(context.Background(), Options{Repository: os.Getenv("OCC_TEST_REPOSITORY")})
	if err == nil || !strings.Contains(err.Error(), "development API and Kubernetes API ports must differ") {
		t.Fatalf("expected rendered port rejection, got %v", err)
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatalf("startup touched its state directory: %v", err)
	}
	log := commands()
	if !composeConfigRan(log) {
		t.Fatalf("rejection came before the rendered check: %v", log)
	}
	for _, command := range log {
		if strings.Contains(command, " up ") || strings.HasPrefix(command, "k3d cluster create") || strings.Contains(command, " build") {
			t.Fatalf("startup did work before the rejection: %s", command)
		}
	}
}

// composeAPIPortCollisionFixture fakes the tools Compose-plane startup runs up
// to its rendered configuration, which publishes the controller API on renderedAPI.
func composeAPIPortCollisionFixture(t *testing.T, shellAPI, renderedAPI, kubernetes string) func() []string {
	t.Helper()
	rendered := `{"networks":{"development":{"ipam":{"config":[{"subnet":"172.30.0.0/24"}]}}},"services":{` +
		`"postgres":{"ports":["127.0.0.1:55432:5432"]},` +
		`"controller":{"ports":["127.0.0.1:` + renderedAPI + `:3000"]},` +
		`"worker-kubernetes":{}}}`
	commands := fakeProfileCommands(t, map[string]string{
		"docker": `
"version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker Engine - Community"}}' ;;
"info"|"compose version"|"info --format "*) ;;
"ps --all --quiet --filter "*|"volume ls --quiet --filter "*|"network ls --quiet --filter "*) ;;
"volume inspect "*|"network inspect "*) exit 1 ;;
"compose --project-name "*" config") echo '` + rendered + `' ;;
`,
		"k3d":     `"cluster list -o json") echo '[]' ;;`,
		"kubectl": "",
		"node":    "",
	})
	for _, key := range []string{"OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE", developmentImageRegistrySetting, "DOCKER_CONTEXT"} {
		t.Setenv(key, "")
	}
	t.Setenv("DOCKER_HOST", "unix:///run/occ-test/docker.sock")
	t.Setenv("OCC_DEVELOPMENT_CONTAINER_ENGINE", "docker")
	t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", "compose")
	t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
	t.Setenv("OPENCLAW_DEV_PORT", shellAPI)
	t.Setenv("OCC_DEVELOPMENT_KUBERNETES_API_PORT", kubernetes)
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCC_TEST_REPOSITORY", parent)
	t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", filepath.Join(parent, "state"))
	return commands
}
