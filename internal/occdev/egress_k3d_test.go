package occdev

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

func TestProtectedEgressSelectionFailsBeforeEffects(t *testing.T) {
	const retired = "OCC_DEVELOPMENT_PROTECTED_EGRESS=1 is retired; unset it or set it to 0 for ordinary development. This does not convert an existing installation; use occ dev down for cleanup."
	const hostRetired = "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP is retired; remove this setting"
	r := &runner{env: candidateOpenShellEnvironment()}
	r.env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] = "kubernetes"
	r.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = "1"
	check := func(want string) {
		t.Helper()
		err := r.protectedEgressSelection()
		if (want == "" && err != nil) || (want != "" && (err == nil || err.Error() != want)) {
			t.Fatalf("selection: err=%v, want %q", err, want)
		}
	}
	// Even the formerly supported selection must refuse before provisioning.
	check(retired)
	for _, value := range []string{"1", "0", ""} {
		r.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = value
		for _, address := range []string{"172.30.42.1", ""} {
			r.env["OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"] = address
			check(hostRetired)
		}
	}
	delete(r.env, "OCC_DEVELOPMENT_PROTECTED_EGRESS")
	check(hostRetired)
	r.env["OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"] = ""
	for _, value := range []string{"true", "yes", "2"} {
		r.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = value
		check("OCC_DEVELOPMENT_PROTECTED_EGRESS must be 0 or 1")
	}
	delete(r.env, "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP")
	for _, value := range []string{"", "0"} {
		r.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] = value
		check("")
	}
	delete(r.env, "OCC_DEVELOPMENT_PROTECTED_EGRESS")
	check("")

	// Direct Kubernetes startup must refuse before tools or state creation,
	// even when it is called without the CLI's shared profile check.
	directory := filepath.Join(t.TempDir(), "state")
	t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", directory)
	t.Setenv("OCC_DEVELOPMENT_PROTECTED_EGRESS", "1")
	t.Setenv("PATH", t.TempDir())
	// Absence matters for this retired override; an empty value is also refused.
	t.Setenv("OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP", "")
	if err := os.Unsetenv("OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP"); err != nil {
		t.Fatal(err)
	}
	if err := upK3d(context.Background(), Options{}, "openshell", nil, nil); err == nil || err.Error() != retired {
		t.Fatalf("direct startup: %v", err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("direct startup created state: %v", err)
	}
}

func TestDevelopmentDatabaseSelectorIsDisposable(t *testing.T) {
	r := &runner{env: map[string]string{}}
	if name, err := r.selectedDevelopmentDatabase("compose"); err != nil || name != "openclaw_enterprise" {
		t.Fatalf("default changed: %s %v", name, err)
	}
	for _, name := range []string{"", "production", "openclaw_enterprise", "openclaw_k8s_", "openclaw_k8s_Foo", "openclaw_k8s_x;DROP DATABASE x", "openclaw_k8s_" + strings.Repeat("a", 51)} {
		r.env["OCC_DEVELOPMENT_DATABASE_NAME"] = name
		if _, err := r.selectedDevelopmentDatabase("kubernetes"); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	r.env["OCC_DEVELOPMENT_DATABASE_NAME"] = "openclaw_k8s_connected"
	if _, err := r.selectedDevelopmentDatabase("compose"); err == nil {
		t.Fatal("Compose accepted an unsupported database selector")
	}
	if name, err := r.selectedDevelopmentDatabase("kubernetes"); err != nil || name != "openclaw_k8s_connected" {
		t.Fatalf("valid database refused: %v", err)
	}
}

// Exercise only inert command boundaries; no engine, supplier chart or runtime is used.
func TestAuthenticatedPlatformInstallationOrder(t *testing.T) {
	for _, gatewayExit := range []string{"0", "42"} {
		t.Run("gateway exit "+gatewayExit, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			assets := &openShellDevelopmentAssets{gatewayChart: "/fixture/openshell-gateway",
				gatewayImage:       "registry.example/gateway@" + profileTestDigest,
				sandboxImage:       "registry.example/sandbox@" + profileTestDigest,
				supervisorImage:    "registry.example/supervisor@" + profileTestDigest,
				workspaceResources: []any{map[string]any{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]string{"name": "openshell-sandbox"}}}}
			t.Setenv("PATH", t.TempDir())
			commands := fakeProfileCommands(t, map[string]string{
				"kubectl": `"get namespace oce-system") ;;
"apply -f "*) ;;
"get node k3d-occ-dev-owned-server-0 -o json") echo '{"spec":{"podCIDR":"10.42.0.0/24"}}' ;;
"get service openshell-gateway --namespace oce-system -o jsonpath={.spec.clusterIP}") echo 10.43.0.50 ;;
` + controlPlaneKubectlCases,
				"docker": `"exec k3d-occ-dev-owned-server-0 ip route get 10.42.0.2") echo '10.42.0.2 dev cni0 src 10.42.0.1' ;;
` + controlPlaneNetworkCase,
				"helm": `"upgrade --install openshell-gateway "*) exit ` + gatewayExit + ` ;;
"upgrade --install openclaw-enterprise deploy/helm/openclaw-enterprise "*) ;;
`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			err := r.installDevelopmentPlatform(context.Background(), state, developmentPlatformInputs{
				openShell: assets, runtimeImage: "registry.example/runtime@" + profileTestDigest,
				controllerImage: "registry.example/controller@" + profileTestDigest,
				postgresImage:   "registry.example/postgres@" + profileTestDigest,
			}, time.Minute)
			log := commands()
			var gateway, control []int
			for i, command := range log {
				if strings.HasPrefix(command, "helm ") {
					if strings.Contains(command, " openshell-gateway ") {
						gateway = append(gateway, i)
					} else {
						control = append(control, i)
					}
				}
			}
			if len(gateway) != 1 || !slices.Contains(strings.Fields(log[gateway[0]]), "--wait") {
				t.Fatalf("expected one Gateway Helm --wait: %v", log)
			}
			values := readJSONFile(t, filepath.Join(state.directory, "openshell-gateway-values.json"))
			if field(t, values, "pkiInitJob", "enabled") != true ||
				field(t, values, "server", "disableTls") != false ||
				field(t, values, "server", "tls", "enableMtls") != true ||
				field(t, values, "server", "auth", "allowUnauthenticatedUsers") != false ||
				len(field(t, values, "gatewayConfig", "openshell.supervisor.middleware").([]any)) != 0 {
				t.Fatal("Gateway must use native PKI, TLS/mTLS and authenticated access without middleware")
			}
			if gatewayExit != "0" {
				if err == nil || !strings.Contains(err.Error(), "exit status "+gatewayExit) || len(control) != 0 || gateway[0] != len(log)-1 {
					t.Fatalf("Gateway failure must stop before OCE: err=%v commands=%v", err, log)
				}
				return
			}
			if err != nil {
				t.Fatalf("platform installation: %v; commands=%v", err, log)
			}
			if len(control) != 1 || control[0] <= gateway[0] ||
				!slices.Contains(strings.Fields(log[control[0]]), "--wait") ||
				strings.Contains(log[control[0]], "worker.replicaCount") {
				t.Fatalf("expected one ordinary OCE install after Gateway readiness: %v", log)
			}
			checkWorkerAccess(t, state.directory, state.PlatformNamespace)
			oce := readJSONFile(t, filepath.Join(state.directory, "helm-values.json"))
			if field(t, oce, "backend", "openshell", "clientSecretName") != "openshell-client-tls" ||
				oce["worker"] != nil {
				t.Fatal("ordinary worker and client trust configuration missing")
			}
		})
	}
}

func renderDevelopmentChart(t *testing.T, helm string, state *developmentState, release, chart, values string, extra ...string) []byte {
	t.Helper()
	args := []string{"template", release, chart, "--namespace", state.PlatformNamespace, "-f", filepath.Join(state.directory, values)}
	cmd := exec.Command(helm, append(args, extra...)...)
	cmd.Dir = state.Repository
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s chart rejected launch values: %v\n%s", release, err, out)
	}
	return out
}

func assertDevelopmentReplicas(t *testing.T, manifest []byte, workers int) {
	t.Helper()
	var deployments []any
	decoder := yaml.NewDecoder(bytes.NewReader(manifest))
	for {
		var obj map[string]any
		if err := decoder.Decode(&obj); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if obj["kind"] == "Deployment" {
			deployments = append(deployments, obj)
		}
	}
	for component, replicas := range map[string]int{"api": 1, "worker": workers} {
		name := "openclaw-enterprise-" + component
		obj := manifestByKind(t, deployments, "Deployment", name)
		if n := field(t, obj, "spec", "replicas"); n != float64(replicas) {
			t.Errorf("%s Deployment requests %v replicas; want %d", name, n, replicas)
		}
	}
}

func checkWorkerAccess(t *testing.T, dir, namespace string) {
	t.Helper()
	const workspaceRole = "openclaw-development-openshell-workspace-rbac"
	bindings := map[string]string{"openclaw-development-tenant-worker": "openclaw-enterprise-openclaw-tenant-worker", workspaceRole: workspaceRole}
	access := readJSONFile(t, filepath.Join(dir, "development-tenant-access.json"))
	for name, role := range bindings {
		binding := manifestByKind(t, access["items"].([]any), "ClusterRoleBinding", name)
		subject := field(t, binding, "subjects", 0).(map[string]any)
		if subject["kind"] != "ServiceAccount" || subject["name"] != "openclaw-enterprise-worker" ||
			subject["namespace"] != namespace || field(t, binding, "roleRef", "name") != role {
			t.Fatalf("%s must grant %s to the development worker account", name, role)
		}
	}
	policies := readJSONFile(t, filepath.Join(dir, "openshell-network-policies.json"))["items"].([]any)
	for _, name := range []string{"openclaw-enterprise-openshell-egress", "openclaw-development-openshell-ingress"} {
		policy := manifestByKind(t, policies, "NetworkPolicy", name)
		if field(t, policy, "metadata", "namespace") != namespace {
			t.Fatalf("expected %s policy in %s", name, namespace)
		}
	}
}
