package occdev

import "fmt"

// Defaults for an unset or empty development profile selector. Every Go entry
// point resolves them here; scripts/dev-up keeps its own Docker default
// because occ dev up selects Docker explicitly when it runs that script.
const (
	defaultDevelopmentComputeDriver = "docker"
	defaultDevelopmentControlPlane  = "compose"
	defaultDevelopmentSandboxDriver = "none"
)

// Profile is the selected local development profile: the Compute Driver, the
// control plane, and the Sandbox Driver. Values are as selected (or the
// defaults), not yet validated; the Check methods refuse unsupported values
// and combinations.
type Profile struct {
	ComputeDriver string
	ControlPlane  string
	SandboxDriver string
}

// ResolveProfile reads OCC_DEVELOPMENT_COMPUTE_DRIVER,
// OCC_DEVELOPMENT_CONTROL_PLANE and OCC_DEVELOPMENT_SANDBOX_DRIVER through
// getenv. An unset or empty selector takes its default.
func ResolveProfile(getenv func(string) string) Profile {
	setting := func(key, fallback string) string {
		if value := getenv(key); value != "" {
			return value
		}
		return fallback
	}
	return Profile{
		ComputeDriver: setting("OCC_DEVELOPMENT_COMPUTE_DRIVER", defaultDevelopmentComputeDriver),
		ControlPlane:  setting("OCC_DEVELOPMENT_CONTROL_PLANE", defaultDevelopmentControlPlane),
		SandboxDriver: setting("OCC_DEVELOPMENT_SANDBOX_DRIVER", defaultDevelopmentSandboxDriver),
	}
}

func resolveProfile(env map[string]string) Profile {
	return ResolveProfile(func(key string) string { return env[key] })
}

// downComputeDriver chooses the stack occ dev down stops. An explicit
// OCC_DEVELOPMENT_COMPUTE_DRIVER wins. Without one, a selection only
// Kubernetes Compute serves (the Kubernetes control plane or a Sandbox
// Driver) selects the Kubernetes path, Compose options keep the Docker path,
// and otherwise the state directory decides: when it exists, down stops the
// recorded Kubernetes stack; when it is absent, down stops the Docker stack.
// recorded is consulted only in that last case.
func (p Profile) downComputeDriver(computeSelected, composeOptions bool, recorded func() (bool, error)) (string, error) {
	switch {
	case computeSelected:
		return p.ComputeDriver, nil
	case p.ControlPlane == "kubernetes" || p.SandboxDriver != defaultDevelopmentSandboxDriver:
		return "kubernetes", nil
	case composeOptions:
		return p.ComputeDriver, nil
	}
	present, err := recorded()
	if err != nil {
		return "", err
	}
	if present {
		return "kubernetes", nil
	}
	return p.ComputeDriver, nil
}

// KubernetesOnly reports the profile whose control plane also runs in
// Kubernetes: the only one with gateway routing and an HTTPS Console.
func (p Profile) KubernetesOnly() bool {
	return p.ComputeDriver == "kubernetes" && p.ControlPlane == "kubernetes"
}

// CheckComputeDriver refuses an unknown Compute Driver.
func (p Profile) CheckComputeDriver() error {
	if p.ComputeDriver != "docker" && p.ComputeDriver != "kubernetes" {
		return fmt.Errorf("OCC_DEVELOPMENT_COMPUTE_DRIVER must be docker or kubernetes")
	}
	return nil
}

// CheckControlPlane refuses an unknown control plane.
func (p Profile) CheckControlPlane() error {
	if p.ControlPlane != "compose" && p.ControlPlane != "kubernetes" {
		return fmt.Errorf("OCC_DEVELOPMENT_CONTROL_PLANE must be compose or kubernetes")
	}
	return nil
}

// CheckSandboxDriver refuses an unknown Sandbox Driver.
func (p Profile) CheckSandboxDriver() error {
	if p.SandboxDriver != "none" && p.SandboxDriver != "openshell" {
		return fmt.Errorf("OCC_DEVELOPMENT_SANDBOX_DRIVER must be none or openshell")
	}
	return nil
}

// CheckDockerCompute refuses the selections Docker Compute cannot serve: the
// Kubernetes control plane and a Sandbox Driver both need Kubernetes Compute.
func (p Profile) CheckDockerCompute() error {
	if p.ControlPlane == "kubernetes" {
		return fmt.Errorf("OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes requires Kubernetes Compute")
	}
	if p.SandboxDriver != "none" {
		return fmt.Errorf("OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes")
	}
	return nil
}

// checkDatabaseNameCompute refuses OCC_DEVELOPMENT_DATABASE_NAME outside
// Kubernetes Compute.
func (p Profile) checkDatabaseNameCompute(selected bool) error {
	if selected && p.ComputeDriver != "kubernetes" {
		return fmt.Errorf("OCC_DEVELOPMENT_DATABASE_NAME requires Kubernetes Compute")
	}
	return nil
}

// checkKeycloakSignIn refuses Keycloak sign-in outside the routing-enabled
// Kubernetes-only profile.
func (p Profile) checkKeycloakSignIn() error {
	if !p.KubernetesOnly() {
		return fmt.Errorf("OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes and OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes: only the Kubernetes-only profile installs the gateway routing and HTTPS Console that OIDC sign-in needs")
	}
	if p.SandboxDriver != "none" {
		return fmt.Errorf("OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_SANDBOX_DRIVER=none: the %s sandbox profile installs no gateway routing or HTTPS Console", p.SandboxDriver)
	}
	return nil
}
