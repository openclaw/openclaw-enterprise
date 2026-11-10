package occdev

import (
	"strings"
	"testing"
)

func TestResolveProfileDefaults(t *testing.T) {
	want := Profile{ComputeDriver: "docker", ControlPlane: "compose", SandboxDriver: "none", NetworkEgressMode: "restricted"}
	if got := resolveProfile(map[string]string{}); got != want {
		t.Fatalf("unset selectors resolve to %+v, want %+v", got, want)
	}
	empty := map[string]string{"OCC_DEVELOPMENT_COMPUTE_DRIVER": "", "OCC_DEVELOPMENT_CONTROL_PLANE": "", "OCC_DEVELOPMENT_SANDBOX_DRIVER": ""}
	if got := resolveProfile(empty); got != want {
		t.Fatalf("empty selectors resolve to %+v, want %+v", got, want)
	}
	if want.KubernetesOnly() {
		t.Fatal("the default profile reports Kubernetes-only")
	}
	for name, err := range map[string]error{"compute": want.CheckComputeDriver(), "control plane": want.CheckControlPlane(), "sandbox": want.CheckSandboxDriver(), "docker compute": want.CheckDockerCompute()} {
		if err != nil {
			t.Errorf("the default profile fails its %s check: %v", name, err)
		}
	}
}

func TestResolveProfileKeepsSelections(t *testing.T) {
	env := map[string]string{"OCC_DEVELOPMENT_COMPUTE_DRIVER": "kubernetes", "OCC_DEVELOPMENT_CONTROL_PLANE": "kubernetes", "OCC_DEVELOPMENT_SANDBOX_DRIVER": "openshell"}
	want := Profile{ComputeDriver: "kubernetes", ControlPlane: "kubernetes", SandboxDriver: "openshell", NetworkEgressMode: "restricted"}
	if got := resolveProfile(env); got != want || !got.KubernetesOnly() {
		t.Fatalf("selections resolve to %+v, want Kubernetes-only %+v", got, want)
	}
	// Values are not validated while resolving; the checks refuse them.
	unknown := resolveProfile(map[string]string{"OCC_DEVELOPMENT_COMPUTE_DRIVER": "podman", "OCC_DEVELOPMENT_CONTROL_PLANE": "helm", "OCC_DEVELOPMENT_SANDBOX_DRIVER": "gvisor"})
	if unknown != (Profile{ComputeDriver: "podman", ControlPlane: "helm", SandboxDriver: "gvisor", NetworkEgressMode: "restricted"}) {
		t.Fatalf("unknown selections resolve to %+v", unknown)
	}
	if got := ResolveProfile(func(key string) string { return env[key] }); got != want {
		t.Fatalf("ResolveProfile = %+v, want %+v", got, want)
	}
}

func TestProfileRefusals(t *testing.T) {
	for name, test := range map[string]struct {
		profile Profile
		check   func(Profile) error
		want    string
	}{
		"unknown compute":           {Profile{"podman", "compose", "none", "restricted"}, Profile.CheckComputeDriver, "OCC_DEVELOPMENT_COMPUTE_DRIVER must be docker or kubernetes"},
		"unknown control plane":     {Profile{"kubernetes", "helm", "none", "restricted"}, Profile.CheckControlPlane, "OCC_DEVELOPMENT_CONTROL_PLANE must be compose or kubernetes"},
		"unknown sandbox":           {Profile{"kubernetes", "compose", "gvisor", "restricted"}, Profile.CheckSandboxDriver, "OCC_DEVELOPMENT_SANDBOX_DRIVER must be none or openshell"},
		"docker with kubernetes":    {Profile{"docker", "kubernetes", "none", "restricted"}, Profile.CheckDockerCompute, "OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes requires Kubernetes Compute"},
		"docker with openshell":     {Profile{"docker", "compose", "openshell", "restricted"}, Profile.CheckDockerCompute, "OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes"},
		"database name on docker":   {Profile{"docker", "compose", "none", "restricted"}, func(p Profile) error { return p.checkDatabaseNameCompute(true) }, "OCC_DEVELOPMENT_DATABASE_NAME requires Kubernetes Compute"},
		"keycloak on docker":        {Profile{"docker", "compose", "none", "restricted"}, Profile.checkKeycloakSignIn, "OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes and OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes: only the Kubernetes-only profile installs the gateway routing and HTTPS Console that OIDC sign-in needs"},
		"keycloak on compose plane": {Profile{"kubernetes", "compose", "none", "restricted"}, Profile.checkKeycloakSignIn, "only the Kubernetes-only profile"},
		"keycloak with openshell":   {Profile{"kubernetes", "kubernetes", "openshell", "restricted"}, Profile.checkKeycloakSignIn, "OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_SANDBOX_DRIVER=none: the openshell sandbox profile installs no gateway routing or HTTPS Console"},
	} {
		err := test.check(test.profile)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v, want %q", name, err, test.want)
		}
	}
	// The checks that refuse a profile accept the supported ones.
	kubernetes := Profile{"kubernetes", "kubernetes", "none", "restricted"}
	if err := kubernetes.checkKeycloakSignIn(); err != nil {
		t.Errorf("Kubernetes-only profile refused Keycloak: %v", err)
	}
	if err := kubernetes.checkDatabaseNameCompute(true); err != nil {
		t.Errorf("Kubernetes Compute refused a database name: %v", err)
	}
	if err := (Profile{"docker", "compose", "none", "restricted"}).checkDatabaseNameCompute(false); err != nil {
		t.Errorf("Docker Compute refused an unset database name: %v", err)
	}
}
