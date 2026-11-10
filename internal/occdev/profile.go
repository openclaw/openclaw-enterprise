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
// control plane, Sandbox Driver, and network egress mode. Values are as selected (or the
// defaults), not yet validated; the Check methods refuse unsupported values
// and combinations.
type Profile struct {
	ComputeDriver     string
	ControlPlane      string
	SandboxDriver     string
	NetworkEgressMode string
}

// ResolveProfile reads OCC_DEVELOPMENT_COMPUTE_DRIVER,
// OCC_DEVELOPMENT_CONTROL_PLANE, OCC_DEVELOPMENT_SANDBOX_DRIVER, and
// OCC_DEVELOPMENT_NETWORK_EGRESS_MODE through
// getenv. An unset or empty selector takes its default.
func ResolveProfile(getenv func(string) string) Profile {
	setting := func(key, fallback string) string {
		if value := getenv(key); value != "" {
			return value
		}
		return fallback
	}
	// TODO(public-egress-images): Change the protected default after bundled images qualify.
	mode := setting("OCC_DEVELOPMENT_NETWORK_EGRESS_MODE", "restricted")
	controlPlane, sandboxDriver := defaultDevelopmentControlPlane, defaultDevelopmentSandboxDriver
	if mode == "public" {
		controlPlane, sandboxDriver = "kubernetes", "openshell"
	}
	return Profile{
		NetworkEgressMode: mode,
		ComputeDriver:     setting("OCC_DEVELOPMENT_COMPUTE_DRIVER", defaultDevelopmentComputeDriver),
		ControlPlane:      setting("OCC_DEVELOPMENT_CONTROL_PLANE", controlPlane),
		SandboxDriver:     setting("OCC_DEVELOPMENT_SANDBOX_DRIVER", sandboxDriver),
	}
}

func resolveProfile(env map[string]string) Profile {
	return ResolveProfile(func(key string) string { return env[key] })
}

// KubernetesOnly reports the profile whose control plane also runs in
// Kubernetes: the only one with gateway routing and an HTTPS Console.
func (p Profile) KubernetesOnly() bool {
	return p.ComputeDriver == "kubernetes" && p.ControlPlane == "kubernetes"
}

func (p Profile) checkNetworkEgress() error {
	switch p.NetworkEgressMode {
	case "restricted":
		return nil
	case "public":
		if !p.KubernetesOnly() || p.SandboxDriver != "openshell" {
			return fmt.Errorf("public network egress requires Kubernetes Compute, OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell and OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes for authenticated Credential Gateway delivery; otherwise set OCC_DEVELOPMENT_NETWORK_EGRESS_MODE=restricted")
		}
		return nil
	default:
		return fmt.Errorf("OCC_DEVELOPMENT_NETWORK_EGRESS_MODE must be public or restricted")
	}
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
