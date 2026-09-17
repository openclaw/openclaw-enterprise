package occdev

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Down stops the selected Docker stack or the recorded Kubernetes stack.
func Down(ctx context.Context, opts Options) error {
	r := newRunner(opts)
	switch driver := r.setting("OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker"); driver {
	case "docker":
		if err := r.selectEngine(ctx, r.setting("OCC_DEVELOPMENT_CONTAINER_ENGINE", "auto")); err != nil {
			return err
		}
		args := append([]string{"compose"}, opts.ComposeArgs...)
		if r.engine == "podman" {
			if err := r.pinEndpoint(ctx); err != nil {
				return err
			}
			args = append([]string{"compose"}, podmanComposeArgs(opts.ComposeArgs, r.env["COMPOSE_FILE"], r.env["COMPOSE_PATH_SEPARATOR"])...)
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
		if r.engine == "podman" {
			provider, err := exec.LookPath("podman-compose")
			if err != nil {
				return err
			}
			r.env["PODMAN_COMPOSE_PROVIDER"] = provider
		}
		r.useEndpoint(state.DockerHost)
		if err := r.cleanup(ctx, state, true); err != nil {
			return fmt.Errorf("cleanup incomplete; preserving %s for recovery: %w", directory, err)
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

func podmanComposeArgs(args []string, files, separator string) []string {
	result := append([]string{}, args...)
	explicit, override := false, false
	for i, arg := range args {
		value := ""
		if (arg == "-f" || arg == "--file") && i+1 < len(args) {
			value = args[i+1]
		} else if strings.HasPrefix(arg, "--file=") {
			value = strings.TrimPrefix(arg, "--file=")
		} else if strings.HasPrefix(arg, "-f") && len(arg) > 2 {
			value = arg[2:]
		}
		if value != "" {
			explicit = true
			if filepath.Base(value) == "compose.podman.yaml" {
				override = true
			}
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
	return result
}
