package occdev

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const stateMarker = "openclaw-enterprise-development-v3\n"

var clusterName = regexp.MustCompile(`^occ-dev-[a-z0-9][a-z0-9-]*$`)
var projectName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
var namespaceName = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`)

// validateClusterName names the rejected OCC_DEVELOPMENT_KUBERNETES_CLUSTER
// value and the rule it broke, so an operator can pick a valid name.
func validateClusterName(name string) error {
	if clusterName.MatchString(name) && len(name) <= 63 {
		return nil
	}
	return fmt.Errorf("invalid OCC_DEVELOPMENT_KUBERNETES_CLUSTER %q: the name must start with occ-dev-, use only lowercase letters, digits, and hyphens (%s), and be at most 63 characters", name, clusterName)
}

type developmentState struct {
	Version           int    `json:"version"`
	Repository        string `json:"repository"`
	ComputeDriver     string `json:"computeDriver"`
	SandboxDriver     string `json:"sandboxDriver"`
	DeploymentMode    string `json:"deploymentMode,omitempty"`
	PlatformNamespace string `json:"platformNamespace,omitempty"`
	APIPort           int    `json:"apiPort,omitzero"`
	BrowserPort       int    `json:"browserPort,omitzero"`
	ContainerEngine   string `json:"containerEngine"`
	ComposeProject    string `json:"composeProject"`
	Cluster           string `json:"cluster"`
	DockerHost        string `json:"dockerHost"`
	KeyPath           string `json:"keyPath"`
	KeyOwned          bool   `json:"keyOwned"`
	directory         string
}

func (s *developmentState) composeCommand() []string {
	return []string{"compose", "--project-directory", s.Repository, "--project-name", s.ComposeProject, "-f", filepath.Join(s.directory, "compose.yaml")}
}
func exclusiveWrite(path string, data []byte, mode os.FileMode) (result error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	// OpenFile transferred ownership only after exclusive creation succeeded.
	// A partial output must not block the caller's next startup attempt.
	defer func() {
		if result != nil {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				result = errors.Join(result, fmt.Errorf("remove failed exclusive output: %w", err))
			}
		}
	}()
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}
func stateDirectory(raw, repository string, existing bool) (string, error) {
	if raw == "" {
		// System temporary directories may contain aliases, such as /var on macOS.
		// Resolve the helper-selected default once; explicit paths remain canonical.
		temporary, err := filepath.EvalSymlinks(os.TempDir())
		if err != nil {
			return "", err
		}
		raw = filepath.Join(temporary, "openclaw-development")
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("state directory must be absolute")
	}
	path := filepath.Clean(raw)
	home, _ := os.UserHomeDir()
	if path == "/" || path == "/tmp" || path == filepath.Clean(os.TempDir()) || path == repository || path == home {
		return "", fmt.Errorf("refusing unsafe state directory: %s", path)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	if parent != filepath.Dir(path) {
		return "", fmt.Errorf("state directory must have a canonical parent without symlinks")
	}
	if existing {
		if err := privateOwned(path, true); err != nil {
			return "", err
		}
	} else {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			return "", fmt.Errorf("state directory already exists: %s; run occ dev down first", path)
		}
	}
	return path, nil
}
func validateKeyOutput(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("key output must be an absent absolute canonical path")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return fmt.Errorf("key output already exists: %s", path)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return err
	}
	if parent != filepath.Dir(path) {
		return fmt.Errorf("key output parent must not contain symlinks")
	}
	return privateOwned(parent, true)
}
func readState(directory string) (*developmentState, error) {
	for _, name := range []string{".openclaw-development", "state.json"} {
		if err := privateOwned(filepath.Join(directory, name), false); err != nil {
			return nil, err
		}
	}
	marker, err := os.ReadFile(filepath.Join(directory, ".openclaw-development"))
	if err != nil || string(marker) != stateMarker {
		return nil, fmt.Errorf("state directory has no valid development marker")
	}
	data, err := os.ReadFile(filepath.Join(directory, "state.json"))
	if err != nil {
		return nil, err
	}
	var state developmentState
	if err := json.Unmarshal(data, &state, json.RejectUnknownMembers(true)); err != nil {
		return nil, fmt.Errorf("invalid development state: %w", err)
	}
	if !filepath.IsAbs(state.Repository) || state.Version != 3 || state.ComputeDriver != "kubernetes" || (state.SandboxDriver != "none" && state.SandboxDriver != "openshell") || (state.ContainerEngine != "docker" && state.ContainerEngine != "podman") || !clusterName.MatchString(state.Cluster) || !strings.HasPrefix(state.DockerHost, "unix:///") || !filepath.IsAbs(state.KeyPath) {
		return nil, fmt.Errorf("unsupported development state")
	}
	switch state.DeploymentMode {
	case "":
		if !projectName.MatchString(state.ComposeProject) {
			return nil, fmt.Errorf("unsupported development state")
		}
		if err := privateOwned(filepath.Join(directory, "compose.yaml"), false); err != nil {
			return nil, err
		}
	case "k3d":
		if state.ComposeProject != "" || !namespaceName.MatchString(state.PlatformNamespace) || state.APIPort < 1 || state.APIPort > 65535 || state.BrowserPort < 0 || state.BrowserPort > 65535 {
			return nil, fmt.Errorf("unsupported development state")
		}
	default:
		return nil, fmt.Errorf("unsupported development state")
	}
	if state.KeyOwned && state.KeyPath != filepath.Join(directory, "initial-admin-service-key.json") {
		return nil, fmt.Errorf("helper-owned key must be inside the state directory")
	}
	state.directory = directory
	return &state, nil
}
