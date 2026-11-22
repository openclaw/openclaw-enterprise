package occdev

import "fmt"

// Defaults for an unset or empty development profile selector. Every Go entry
// point and scripts/dev-up resolve them the same way: unset Compute selects
// Kubernetes, and an unset control plane follows the Compute Driver (see
// ResolveProfile). occ dev up names Docker Compute explicitly when it runs
// scripts/dev-up for it.
const (
	defaultDevelopmentComputeDriver = "kubernetes"
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
// getenv. An unset or empty selector takes its default: Kubernetes Compute,
// no Sandbox Driver, and the control plane of the selected Compute Driver,
// so nothing selected means the Kubernetes-only profile.
func ResolveProfile(getenv func(string) string) Profile {
	return resolveProfileFor(getenv, profileSetting(getenv, "OCC_DEVELOPMENT_COMPUTE_DRIVER", defaultDevelopmentComputeDriver))
}

// resolveProfileFor resolves the profile for computeDriver. An unset control
// plane is the Kubernetes control plane on Kubernetes Compute and the Compose
// control plane otherwise: Docker Compute serves only the Compose control
// plane, so COMPUTE=docker alone keeps passing CheckDockerCompute.
func resolveProfileFor(getenv func(string) string, computeDriver string) Profile {
	controlPlane := "compose"
	if computeDriver == "kubernetes" {
		controlPlane = "kubernetes"
	}
	return Profile{
		ComputeDriver: computeDriver,
		ControlPlane:  profileSetting(getenv, "OCC_DEVELOPMENT_CONTROL_PLANE", controlPlane),
		SandboxDriver: profileSetting(getenv, "OCC_DEVELOPMENT_SANDBOX_DRIVER", defaultDevelopmentSandboxDriver),
	}
}

func profileSetting(getenv func(string) string, key, fallback string) string {
	if value := getenv(key); value != "" {
		return value
	}
	return fallback
}

func resolveProfile(env map[string]string) Profile {
	return ResolveProfile(func(key string) string { return env[key] })
}

// downReason records why occ dev down chose its stack.
type downReason int

const (
	// downComputeSelected: OCC_DEVELOPMENT_COMPUTE_DRIVER was set.
	downComputeSelected downReason = iota
	// downKubernetesSelected: the Kubernetes control plane or a Sandbox
	// Driver was selected, which only Kubernetes Compute serves.
	downKubernetesSelected
	// downComposeOptions: Compose options after "--" keep the Docker stack.
	downComposeOptions
	// downRecordedState: nothing was selected and the state directory exists.
	downRecordedState
	// downNoRecordedState: nothing was selected and the state directory is
	// absent.
	downNoRecordedState
)

// downChoice is the stack occ dev down stops, its profile, and why.
// StateDirectory is the resolved state directory when the choice consulted it,
// otherwise empty.
type downChoice struct {
	Profile        Profile
	Reason         downReason
	StateDirectory string
}

// unselected reports whether nothing selected the stack: the state directory
// decided.
func (c downChoice) unselected() bool {
	return c.Reason == downRecordedState || c.Reason == downNoRecordedState
}

// chooseDownStack chooses the stack occ dev down stops. An explicit
// OCC_DEVELOPMENT_COMPUTE_DRIVER wins. Without one, a selection only
// Kubernetes Compute serves (the Kubernetes control plane or a Sandbox
// Driver) selects the Kubernetes path, Compose options keep the Docker path,
// and otherwise the state directory decides: when it exists, down stops the
// recorded Kubernetes stack; when it is absent, down stops the Docker stack.
// Only the Kubernetes path records state, so the unrecorded fallback is
// Docker even though occ dev up defaults to Kubernetes Compute. recorded
// returns the resolved state directory and whether it exists; it is consulted
// only in that last case.
func chooseDownStack(env map[string]string, composeOptions bool, recorded func() (string, bool, error)) (downChoice, error) {
	selected := resolveProfile(env)
	docker := resolveProfileFor(func(key string) string { return env[key] }, "docker")
	switch {
	case env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "":
		return downChoice{Profile: selected, Reason: downComputeSelected}, nil
	case env["OCC_DEVELOPMENT_CONTROL_PLANE"] == "kubernetes" || selected.SandboxDriver != defaultDevelopmentSandboxDriver:
		return downChoice{Profile: selected, Reason: downKubernetesSelected}, nil
	case composeOptions:
		return downChoice{Profile: docker, Reason: downComposeOptions}, nil
	}
	path, present, err := recorded()
	if err != nil {
		return downChoice{}, err
	}
	if present {
		return downChoice{Profile: selected, Reason: downRecordedState, StateDirectory: path}, nil
	}
	return downChoice{Profile: docker, Reason: downNoRecordedState, StateDirectory: path}, nil
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
