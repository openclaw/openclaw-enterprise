package occdev

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Down stops the selected Docker stack or the recorded Kubernetes stack.
func Down(ctx context.Context, opts Options) error {
	r := newRunner(opts)
	sandbox := r.setting("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
	if sandbox != "none" && sandbox != "openshell" {
		return fmt.Errorf("OCC_DEVELOPMENT_SANDBOX_DRIVER must be none or openshell")
	}
	switch driver := r.setting("OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker"); driver {
	case "docker":
		if r.env["OCC_DEVELOPMENT_CONTROL_PLANE"] == "kubernetes" {
			return fmt.Errorf("OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes requires Kubernetes Compute")
		}
		if sandbox != "none" {
			return fmt.Errorf("OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes")
		}
		// Docker Compute stacks are started by scripts/dev-up with standalone
		// podman-compose; stop them with the same provider or compose down
		// removes nothing.
		if err := r.selectDockerComputeEngine(ctx, r.setting("OCC_DEVELOPMENT_CONTAINER_ENGINE", "auto")); err != nil {
			return err
		}
		args := append([]string{"compose"}, opts.ComposeArgs...)
		if r.engine == "podman" {
			data, err := r.output(ctx, "podman", "info", "--format", "{{.Host.RemoteSocket.Path}}")
			if err != nil {
				return err
			}
			socket := strings.TrimPrefix(string(data), "unix://")
			if !strings.HasPrefix(socket, "/") {
				return fmt.Errorf("Podman did not report an absolute API socket path")
			}
			// The socket is on the engine host, so use it only for the worker mount.
			// Host-side Compose commands must retain Podman's selected connection.
			r.env["OCC_CONTAINER_ENGINE_SOCKET"] = socket
			composeArgs, err := podmanComposeArgs(opts.ComposeArgs, r.env["COMPOSE_FILE"], r.env["COMPOSE_PATH_SEPARATOR"])
			if err != nil {
				return err
			}
			args = append([]string{"compose"}, composeArgs...)
		}
		args = append(args, "down")
		if opts.Volumes {
			args = append(args, "--volumes")
		}
		if err := r.run(ctx, r.engine, args...); err != nil {
			return err
		}
		fmt.Fprintln(r.opts.Out, "Stopped Docker-compatible development stack.")
		return nil
	case "kubernetes":
		if err := checkKubernetesPlatform(); err != nil {
			return err
		}
		if len(opts.ComposeArgs) > 0 {
			return fmt.Errorf("Compose options come from recorded Kubernetes development state")
		}
		directory, err := stateDirectory(r.env["OCC_DEVELOPMENT_STATE_DIRECTORY"], opts.Repository, true)
		if err != nil {
			return err
		}
		lock, err := lockState(directory)
		if err != nil {
			return err
		}
		defer lock.Close()
		state, err := readState(directory)
		if err != nil {
			return err
		}
		r.env["KUBECONFIG"] = filepath.Join(directory, "kubeconfig")
		r.engine = state.ContainerEngine
		r.useEndpoint(state.DockerHost)
		cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		if err := r.cleanup(cleanupCtx, state, true); err != nil {
			return fmt.Errorf("cleanup incomplete; preserving %s for recovery: %w", directory, err)
		}
		// k3d can report successful cluster deletion after only warning that
		// its image volume could not be removed. Check the recorded endpoint
		// even when the cluster was already absent on this attempt.
		imageVolume := "k3d-" + state.Cluster + "-images"
		volumes, err := r.output(ctx, r.engine, "volume", "ls", "--filter", "label=k3d.cluster="+state.Cluster, "--format", "{{.Name}}")
		if err != nil {
			return fmt.Errorf("cleanup incomplete; preserving %s for recovery: cannot confirm k3d image volume absence for %s: %w; "+
				"check access to the recorded %s endpoint %s; retry occ dev down with the same Kubernetes settings and state directory",
				directory, imageVolume, err, r.engine, state.DockerHost)
		}
		for _, volume := range strings.Fields(string(volumes)) {
			if volume == imageVolume {
				// Down does not remove the volume itself; tell the operator how to finish.
				return fmt.Errorf("cleanup incomplete; preserving %s for recovery: k3d image volume %s remains; "+
					"select the recorded %s endpoint %s, verify label k3d.cluster=%s and that the volume is unused before removing it there; "+
					"retry occ dev down with the same Kubernetes settings and state directory",
					directory, imageVolume, r.engine, state.DockerHost, state.Cluster)
			}
		}
		if err := os.RemoveAll(directory); err != nil {
			return err
		}
		fmt.Fprintf(r.opts.Out, "Stopped Kubernetes development stack %s.\n", state.Cluster)
		return nil
	default:
		return fmt.Errorf("OCC_DEVELOPMENT_COMPUTE_DRIVER must be docker or kubernetes")
	}
}
func (r *runner) cleanup(ctx context.Context, s *developmentState, clusterAttempted bool) error {
	var failures []error
	if s.DeploymentMode == "k3d" {
		if clusterAttempted {
			// Before the delete, which keeps a network the registry still uses
			// and would leave it behind; a retry detaches, then deletes.
			if err := r.detachRecordedDevelopmentImageRegistry(ctx, s); err != nil {
				return err
			}
			exists, err := r.clusterExists(ctx, s.Cluster)
			if err != nil {
				failures = append(failures, err)
			} else if exists {
				if s.SignIn == developmentSignInKeycloak {
					r.removeDevelopmentKeycloak(ctx, s)
				}
				if err := r.run(ctx, "k3d", "cluster", "delete", s.Cluster); err != nil {
					failures = append(failures, err)
				}
			}
		}
		return errors.Join(failures...)
	}
	// Stop reconcilers before removing their cluster and database. Continue after failures to reclaim what we can.
	if err := r.stopComposeReconcilers(ctx, s); err != nil {
		failures = append(failures, err)
	}
	if clusterAttempted {
		exists, err := r.clusterExists(ctx, s.Cluster)
		if err != nil {
			failures = append(failures, err)
		} else if exists {
			if err := r.run(ctx, "k3d", "cluster", "delete", s.Cluster); err != nil {
				failures = append(failures, err)
			}
		}
	}
	if err := r.removeComposeResources(ctx, s); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

func (r *runner) stopComposeReconcilers(ctx context.Context, s *developmentState) error {
	if r.engine != "podman" {
		return r.compose(ctx, s, "stop", "controller", "worker-kubernetes")
	}
	var failures []error
	for _, service := range []string{"controller", "worker-kubernetes"} {
		id, err := r.composeServiceID(ctx, s, service)
		if err == nil && len(id) != 0 {
			err = r.run(ctx, r.engine, "stop", string(id))
		}
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

// Podman Compose does not propagate every removal failure. Use engine calls
// against exact project labels, including partial startups, and verify absence
// before allowing the caller to discard recovery state. Never prune images or
// unrelated resources, or require the original Compose inputs during cleanup.
func (r *runner) removeComposeResources(ctx context.Context, s *developmentState) error {
	if r.engine != "podman" {
		return r.compose(ctx, s, "down", "--volumes")
	}
	var failures []error
	failures = append(failures, r.removeComposeContainers(ctx, s))
	for _, kind := range []string{"volume", "network"} {
		names, err := r.composeResources(ctx, s, kind)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		for _, name := range names {
			failures = append(failures, r.run(ctx, r.engine, kind, "rm", name))
		}
		remaining, err := r.composeResources(ctx, s, kind)
		if err != nil {
			failures = append(failures, err)
		} else if len(remaining) != 0 {
			failures = append(failures, fmt.Errorf("project-owned %s resources remain after cleanup", kind))
		}
	}
	return errors.Join(failures...)
}

func (r *runner) removeComposeContainers(ctx context.Context, s *developmentState) error {
	names, err := r.composeResources(ctx, s, "container")
	if err != nil {
		return err
	}
	for len(names) != 0 {
		// Podman rejects removal of a prerequisite until its dependants are gone.
		// Retry while the owned set shrinks; --depend could remove someone else's
		// container, so never cascade beyond the exact project inventory.
		_, removalErr := r.output(ctx, r.engine, append([]string{"container", "rm", "--force", "--volumes"}, names...)...)
		remaining, err := r.composeResources(ctx, s, "container")
		if err != nil {
			return errors.Join(removalErr, err)
		}
		if len(remaining) >= len(names) {
			return errors.Join(removalErr, fmt.Errorf("project-owned containers remain after cleanup"))
		}
		names = remaining
	}
	return nil
}

func (r *runner) composeResources(ctx context.Context, s *developmentState, kind string) ([]string, error) {
	var names []string
	for _, prefix := range []string{"com.docker.compose", "io.podman.compose"} {
		args := []string{kind, "ls", "--quiet"}
		if kind == "container" {
			args = append(args, "--all")
		}
		data, err := r.output(ctx, r.engine, append(args, "--filter", "label="+prefix+".project="+s.ComposeProject)...)
		if err != nil {
			return nil, err
		}
		names = append(names, strings.Fields(string(data))...)
	}
	slices.Sort(names)
	return slices.Compact(names), nil
}

func podmanComposeArgs(args []string, files, separator string) ([]string, error) {
	result := make([]string, 0, len(args)+2)
	explicit, override := false, false
	for i := 0; i < len(args); i++ {
		arg, value := args[i], ""
		switch {
		case arg == "-f" || arg == "--file":
			result = append(result, arg)
			if i+1 < len(args) {
				i++
				value = args[i]
				result = append(result, value)
			}
		case strings.HasPrefix(arg, "--file="):
			value = strings.TrimPrefix(arg, "--file=")
			result = append(result, arg)
		case strings.HasPrefix(arg, "-f") && len(arg) > 2:
			// Podman can interpret an "h" in -fFILE as help. Match scripts/dev-up.
			value = strings.TrimPrefix(arg[2:], "=")
			result = append(result, "--file="+value)
		default:
			result = append(result, arg)
			continue
		}
		if value == "" {
			return nil, fmt.Errorf("--file requires a Compose file path")
		}
		explicit = true
		if filepath.Base(value) == "compose.podman.yaml" {
			override = true
		}
	}
	if !explicit {
		if files == "" {
			result = append(result, "-f", "compose.yaml")
		} else {
			if separator == "" {
				separator = string(os.PathListSeparator)
			}
			for _, file := range strings.Split(files, separator) {
				result = append(result, "-f", file)
				if filepath.Base(file) == "compose.podman.yaml" {
					override = true
				}
			}
		}
	}
	if !override {
		result = append(result, "-f", "compose.podman.yaml")
	}
	return result, nil
}
