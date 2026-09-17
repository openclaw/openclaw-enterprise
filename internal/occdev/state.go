package occdev

import (
	"encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const stateMarker = "openclaw-enterprise-development-v2\n"

var clusterName = regexp.MustCompile(`^occ-dev-[a-z0-9][a-z0-9-]*$`)
var projectName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

type developmentState struct {
	Version         int    `json:"version"`
	Repository      string `json:"repository"`
	ComputeDriver   string `json:"computeDriver"`
	ContainerEngine string `json:"containerEngine"`
	ComposeProject  string `json:"composeProject"`
	Cluster         string `json:"cluster"`
	DockerHost      string `json:"dockerHost"`
	KeyPath         string `json:"keyPath"`
	KeyOwned        bool   `json:"keyOwned"`
	directory       string
}

func (s *developmentState) composeCommand() []string {
	return []string{"compose", "--project-directory", s.Repository, "--project-name", s.ComposeProject, "-f", filepath.Join(s.directory, "compose.yaml")}
}
func exclusiveWrite(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
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
	for _, name := range []string{".openclaw-development", "state.json", "compose.yaml"} {
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
	if !filepath.IsAbs(state.Repository) || state.Version != 2 || state.ComputeDriver != "kubernetes" || (state.ContainerEngine != "docker" && state.ContainerEngine != "podman") || !projectName.MatchString(state.ComposeProject) || !clusterName.MatchString(state.Cluster) || !strings.HasPrefix(state.DockerHost, "unix:///") || !filepath.IsAbs(state.KeyPath) {
		return nil, fmt.Errorf("unsupported development state")
	}
	if state.KeyOwned && state.KeyPath != filepath.Join(directory, "initial-admin-service-key.json") {
		return nil, fmt.Errorf("helper-owned key must be inside the state directory")
	}
	state.directory = directory
	return &state, nil
}
