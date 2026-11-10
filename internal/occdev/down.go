package occdev

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Down stops the selected Docker stack or the recorded Kubernetes stack.
// Without a Compute Driver selection it follows the state directory; see
// Profile.downComputeDriver.
func Down(ctx context.Context, opts Options) error {
	r := newRunner(opts)
	profile := resolveProfile(r.env)
	if err := profile.CheckSandboxDriver(); err != nil {
		return err
	}
	stateSetting := r.env["OCC_DEVELOPMENT_STATE_DIRECTORY"]
	choice, err := profile.downComputeDriver(r.env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "", len(opts.ComposeArgs) > 0, func() (string, bool, error) {
		return recordedStateDirectory(stateSetting)
	})
	if err != nil {
		return err
	}
	switch choice.ComputeDriver {
	case "docker":
		if err := profile.CheckDockerCompute(); err != nil {
			return err
		}
		// Docker Compute stacks are started by scripts/dev-up with standalone
		// podman-compose; stop them with the same provider or compose down
		// removes nothing.
		if err := r.selectDockerComputeEngine(ctx, r.setting("OCC_DEVELOPMENT_CONTAINER_ENGINE", "auto")); err != nil {
			return err
		}
		browserEnvironment, err := DockerBrowserEnvironment(opts.Repository, false)
		if err != nil {
			return err
		}
		for key, value := range browserEnvironment {
			r.env[key] = value
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
		args = append([]string{"compose"}, dockerBrowserComposeArgs(args[1:], opts.Repository, r.env["COMPOSE_FILE"], r.env["COMPOSE_PATH_SEPARATOR"])...)
		args = append(args, "down")
		if opts.Volumes {
			args = append(args, "--volumes")
		}
		if err := r.run(ctx, r.engine, args...); err != nil {
			return err
		}
		if choice.Reason == downNoRecordedState {
			// Say why down chose Docker when nothing selected it.
			fmt.Fprintf(r.opts.Out, "Stopped Docker-compatible development stack (no recorded Kubernetes development state in %s).\n", choice.StateDirectory)
			return nil
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
		// When down followed a recorded state directory, never fall back to
		// Docker: name the directory so the operator can repair or remove it.
		unusable := func(err error) error {
			if choice.Reason != downRecordedState {
				if errors.Is(err, fs.ErrNotExist) {
					if path, pathErr := stateDirectoryPath(stateSetting); pathErr == nil {
						return fmt.Errorf("no recorded Kubernetes development state in %s: %w", path, err)
					}
				}
				return err
			}
			return fmt.Errorf("development state directory %s exists but is not usable Kubernetes development state: %w; "+
				"occ dev down stopped nothing; repair it and retry, or select OCC_DEVELOPMENT_COMPUTE_DRIVER=docker to stop a Docker-compatible stack", choice.StateDirectory, err)
		}
		directory, err := stateDirectory(stateSetting, opts.Repository, true)
		if err != nil {
			return unusable(err)
		}
		lock, err := lockState(directory)
		if err != nil {
			return err
		}
		defer lock.Close()
		state, err := readState(directory)
		if err != nil {
			return unusable(err)
		}
		// Every checkout shares the default state directory. Following it
		// without a selection must not stop another checkout's stack.
		if choice.Reason == downRecordedState && !sameCheckout(state.Repository, opts.Repository) {
			return fmt.Errorf("development state directory %s records the Kubernetes development stack %s of checkout %s, not this checkout %s; "+
				"occ dev down stopped nothing; run occ dev down from %s, or select OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes to stop that stack from here "+
				"(OCC_DEVELOPMENT_COMPUTE_DRIVER=docker stops this checkout's Docker-compatible stack)",
				directory, state.Cluster, state.Repository, opts.Repository, state.Repository)
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
		return profile.CheckComputeDriver()
	}
}

// sameCheckout reports whether two checkout paths name the same directory,
// including through a symlinked path.
func sameCheckout(recorded, current string) bool {
	if filepath.Clean(recorded) == filepath.Clean(current) {
		return true
	}
	a, err := os.Stat(recorded)
	if err != nil {
		return false
	}
	b, err := os.Stat(current)
	return err == nil && os.SameFile(a, b)
}

func (r *runner) cleanup(ctx context.Context, s *developmentState, clusterAttempted bool) error {
	var failures []error
	// A recorded import attachment must not keep either profile's owned network alive.
	if clusterAttempted {
		if err := r.detachRecordedDevelopmentImageRegistry(ctx, s); err != nil {
			return err
		}
	}
	if s.DeploymentMode == "k3d" {
		if clusterAttempted {
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
