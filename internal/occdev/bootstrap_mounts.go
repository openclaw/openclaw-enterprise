package occdev

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"path/filepath"
	"strings"
)

// PrepareBootstrapMounts is the Docker Compute launcher's private-file preparation step.
func PrepareBootstrapMounts(ctx context.Context, opts Options, directory string) error {
	r := newRunner(opts)
	// The parent launcher has already selected its engine and connection.
	r.engine = r.env["OCC_DEVELOPMENT_CONTAINER_ENGINE"]
	if r.engine != "docker" && r.engine != "podman" {
		return fmt.Errorf("bootstrap mount preparation requires the selected docker or podman engine")
	}
	return r.prepareBootstrapMounts(ctx, directory, append([]string{"compose"}, opts.ComposeArgs...))
}

func (r *runner) prepareBootstrapMounts(ctx context.Context, directory string, prefix []string) error {
	// Build outside the readiness budget, then drain each Compose provider before
	// its caller can roll back resources or remove the credential inputs.
	if _, err := r.invokeComposeCommand(ctx, prefix, false, "build", "bootstrap"); err != nil {
		return err
	}
	// Inspect the actual container, including Compose user overrides, before any reader starts.
	if _, err := r.invokeComposeCommand(ctx, prefix, false, "up", "--no-start", "--no-build", "--no-deps", "bootstrap"); err != nil {
		return err
	}
	args := []string{"ps"}
	if r.engine == "docker" {
		args = append(args, "--all")
	}
	args = append(args, "--quiet")
	if r.engine == "docker" {
		args = append(args, "bootstrap")
	}
	// podman-compose 1.5 rejects service arguments to ps. Only bootstrap has
	// been created in this project; retain the single-container refusal below.
	id, err := r.invokeComposeCommand(ctx, prefix, true, args...)
	if err != nil {
		return err
	}
	if len(strings.Fields(string(id))) != 1 {
		return fmt.Errorf("expected one bootstrap container for credential ownership")
	}
	data, err := r.output(ctx, r.engine, "inspect", "--format", `{"image":{{json .Image}},"user":{{json .Config.User}}}`, string(id))
	if err != nil {
		return err
	}
	var container struct {
		Image string `json:"image"`
		User  string `json:"user"`
	}
	if err := json.Unmarshal(data, &container); err != nil || container.Image == "" {
		return fmt.Errorf("could not resolve bootstrap reader image")
	}
	args = []string{"run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"}
	if container.User != "" {
		args = append(args, "--user", container.User)
	}
	args = append(args, "--entrypoint", "node", container.Image, "-p", "JSON.stringify([process.getuid(),process.getgid()])")
	data, err = r.output(ctx, r.engine, args...)
	if err != nil {
		return err
	}
	var owner []int
	if err := json.Unmarshal(data, &owner); err != nil || len(owner) != 2 || owner[0] <= 0 || owner[1] < 0 {
		return fmt.Errorf("bootstrap must use a non-root credential reader")
	}
	// Only disposable mount copies change owner. Host recovery inputs remain private and readable.
	return r.assignComposeFileOwner(ctx, &developmentState{directory: filepath.Clean(directory)}, container.Image, [2]int{owner[0], owner[1]}, []string{"mount-admin-password", "mount-admin-service-key"})
}
