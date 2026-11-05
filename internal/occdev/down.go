package occdev

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
		if r.engine == "podman" && state.DeploymentMode == "" {
			// The same provider preference as startup, so every host that can
			// start the Compose control plane can also stop it.
			provider, err := composeProvider()
			if err != nil {
				return err
			}
			r.env["PODMAN_COMPOSE_PROVIDER"] = provider
		}
		r.useEndpoint(state.DockerHost)
		if err := r.cleanup(ctx, state, true); err != nil {
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
	if err := r.compose(ctx, s, "stop", "controller", "worker-kubernetes"); err != nil {
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
	if err := r.compose(ctx, s, "down", "--volumes"); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
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
