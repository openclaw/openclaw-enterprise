package occdev

import (
	"errors"
	"strings"
	"testing"
)

func TestResolveProfileDefaults(t *testing.T) {
	want := Profile{ComputeDriver: "docker", ControlPlane: "compose", SandboxDriver: "none"}
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
	want := Profile{ComputeDriver: "kubernetes", ControlPlane: "kubernetes", SandboxDriver: "openshell"}
	if got := resolveProfile(env); got != want || !got.KubernetesOnly() {
		t.Fatalf("selections resolve to %+v, want Kubernetes-only %+v", got, want)
	}
	// Values are not validated while resolving; the checks refuse them.
	unknown := resolveProfile(map[string]string{"OCC_DEVELOPMENT_COMPUTE_DRIVER": "podman", "OCC_DEVELOPMENT_CONTROL_PLANE": "helm", "OCC_DEVELOPMENT_SANDBOX_DRIVER": "gvisor"})
	if unknown != (Profile{ComputeDriver: "podman", ControlPlane: "helm", SandboxDriver: "gvisor"}) {
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
		"unknown compute":           {Profile{"podman", "compose", "none"}, Profile.CheckComputeDriver, "OCC_DEVELOPMENT_COMPUTE_DRIVER must be docker or kubernetes"},
		"unknown control plane":     {Profile{"kubernetes", "helm", "none"}, Profile.CheckControlPlane, "OCC_DEVELOPMENT_CONTROL_PLANE must be compose or kubernetes"},
		"unknown sandbox":           {Profile{"kubernetes", "compose", "gvisor"}, Profile.CheckSandboxDriver, "OCC_DEVELOPMENT_SANDBOX_DRIVER must be none or openshell"},
		"docker with kubernetes":    {Profile{"docker", "kubernetes", "none"}, Profile.CheckDockerCompute, "OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes requires Kubernetes Compute"},
		"docker with openshell":     {Profile{"docker", "compose", "openshell"}, Profile.CheckDockerCompute, "OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes"},
		"database name on docker":   {Profile{"docker", "compose", "none"}, func(p Profile) error { return p.checkDatabaseNameCompute(true) }, "OCC_DEVELOPMENT_DATABASE_NAME requires Kubernetes Compute"},
		"keycloak on docker":        {Profile{"docker", "compose", "none"}, Profile.checkKeycloakSignIn, "OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes and OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes: only the Kubernetes-only profile installs the gateway routing and HTTPS Console that OIDC sign-in needs"},
		"keycloak on compose plane": {Profile{"kubernetes", "compose", "none"}, Profile.checkKeycloakSignIn, "only the Kubernetes-only profile"},
		"keycloak with openshell":   {Profile{"kubernetes", "kubernetes", "openshell"}, Profile.checkKeycloakSignIn, "OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_SANDBOX_DRIVER=none: the openshell sandbox profile installs no gateway routing or HTTPS Console"},
	} {
		err := test.check(test.profile)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v, want %q", name, err, test.want)
		}
	}
	// The checks that refuse a profile accept the supported ones.
	kubernetes := Profile{"kubernetes", "kubernetes", "none"}
	if err := kubernetes.checkKeycloakSignIn(); err != nil {
		t.Errorf("Kubernetes-only profile refused Keycloak: %v", err)
	}
	if err := kubernetes.checkDatabaseNameCompute(true); err != nil {
		t.Errorf("Kubernetes Compute refused a database name: %v", err)
	}
	if err := (Profile{"docker", "compose", "none"}).checkDatabaseNameCompute(false); err != nil {
		t.Errorf("Docker Compute refused an unset database name: %v", err)
	}
}

func TestDownComputeDriver(t *testing.T) {
	inspectErr := errors.New("cannot inspect development state directory /state: permission denied")
	for name, test := range map[string]struct {
		env            map[string]string
		composeOptions bool
		present        bool
		inspect        error
		want           string
		reason         downReason
		wantErr        string
	}{
		"explicit docker ignores recorded state":        {env: map[string]string{"OCC_DEVELOPMENT_COMPUTE_DRIVER": "docker"}, present: true, want: "docker", reason: downComputeSelected},
		"explicit kubernetes without state":             {env: map[string]string{"OCC_DEVELOPMENT_COMPUTE_DRIVER": "kubernetes"}, want: "kubernetes", reason: downComputeSelected},
		"unset with recorded state":                     {present: true, want: "kubernetes", reason: downRecordedState},
		"unset without recorded state":                  {want: "docker", reason: downNoRecordedState},
		"unset with compose control plane":              {env: map[string]string{"OCC_DEVELOPMENT_CONTROL_PLANE": "compose"}, present: true, want: "kubernetes", reason: downRecordedState},
		"unset with an uninspectable directory":         {inspect: inspectErr, wantErr: inspectErr.Error()},
		"compose options keep docker":                   {composeOptions: true, present: true, want: "docker", reason: downComposeOptions},
		"kubernetes control plane selects kubernetes":   {env: map[string]string{"OCC_DEVELOPMENT_CONTROL_PLANE": "kubernetes"}, want: "kubernetes", reason: downKubernetesSelected},
		"kubernetes control plane with compose options": {env: map[string]string{"OCC_DEVELOPMENT_CONTROL_PLANE": "kubernetes"}, composeOptions: true, want: "kubernetes", reason: downKubernetesSelected},
		"openshell selects kubernetes":                  {env: map[string]string{"OCC_DEVELOPMENT_SANDBOX_DRIVER": "openshell"}, want: "kubernetes", reason: downKubernetesSelected},
	} {
		t.Run(name, func(t *testing.T) {
			consulted := false
			profile := resolveProfile(test.env)
			got, err := profile.downComputeDriver(test.env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "", test.composeOptions, func() (string, bool, error) {
				consulted = true
				return "/state", test.present, test.inspect
			})
			if test.wantErr != "" {
				if err == nil || err.Error() != test.wantErr {
					t.Fatalf("downComputeDriver error = %v, want %q", err, test.wantErr)
				}
				if !consulted {
					t.Fatal("recorded state not consulted")
				}
				return
			}
			if err != nil || got.ComputeDriver != test.want || got.Reason != test.reason {
				t.Fatalf("downComputeDriver = %+v, %v; want %q for reason %d", got, err, test.want, test.reason)
			}
			// Only the unselected choices consult the state directory, and they carry its path.
			if consulted != got.unselected() {
				t.Fatalf("recorded state consulted = %v for reason %d", consulted, got.Reason)
			}
			if wantPath := map[bool]string{true: "/state"}[got.unselected()]; got.StateDirectory != wantPath {
				t.Fatalf("state directory = %q, want %q", got.StateDirectory, wantPath)
			}
		})
	}
}
