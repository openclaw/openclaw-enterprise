package occdev

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
		claims, err := claimsFor(state)
		if err != nil {
			return err
		}
		if err := claims.verify(); err != nil {
			return err
		}
		if _, err := os.Lstat(filepath.Join(directory, uncertainCommandMarker)); !os.IsNotExist(err) {
			return fmt.Errorf("subprocess outcome is uncertain; stop and verify surviving helpers, then remove %s and retry", filepath.Join(directory, uncertainCommandMarker))
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
		if err := state.beginLifecycle(); err != nil {
			return err
		}
		r.lifecycle = true
		cleanupErr := r.cleanup(ctx, state)
		if r.unsettled {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("subprocess outcome is uncertain"))
		} else {
			cleanupErr = errors.Join(cleanupErr, state.completeLifecycle())
		}
		if cleanupErr != nil {
			return fmt.Errorf("cleanup incomplete; preserving %s for recovery: %w", directory, cleanupErr)
		}
		if err := os.RemoveAll(directory); err != nil {
			return err
		}
		if err := claims.release(); err != nil {
			return err
		}
		fmt.Fprintf(r.opts.Out, "Stopped Kubernetes development stack %s.\n", state.Cluster)
		return nil
	default:
		return fmt.Errorf("OCC_DEVELOPMENT_COMPUTE_DRIVER must be docker or kubernetes")
	}
}
func (r *runner) cleanup(ctx context.Context, s *developmentState) error {
	var failures []error
	// Stop reconcilers before removing their cluster and database. Continue after
	// settled failures, but never overlap an uncertain helper.
	if err := r.compose(ctx, s, "stop", "controller", "worker-kubernetes"); err != nil {
		failures = append(failures, err)
	}
	if r.unsettled {
		return errors.Join(failures...)
	}
	if s.ClusterAttempted {
		if err := r.deleteOwnedCluster(ctx, s); err != nil {
			failures = append(failures, err)
		}
	}
	if r.unsettled {
		return errors.Join(failures...)
	}
	if err := r.compose(ctx, s, "down", "--volumes"); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

func (r *runner) deleteOwnedCluster(ctx context.Context, s *developmentState) error {
	containers, witness, err := r.inspectOwnedCluster(ctx, s)
	if err != nil {
		return err
	}
	for _, container := range containers {
		if container.ID == witness {
			continue
		}
		if witness != "" {
			if err := r.verifyResourceOwner(ctx, s, "container", witness); err != nil {
				return err
			}
		}
		// Never let k3d remove the ownership witness while an auxiliary remains.
		// Immutable IDs prevent a same-name replacement from being targeted.
		if err := r.run(ctx, r.engine, "container", "rm", "--force", "--volumes", container.ID); err != nil {
			return err
		}
	}
	remainingNodes, remainingVolumes, err := r.clusterResources(ctx, s.Cluster)
	if err != nil {
		return err
	}
	if (witness == "" && len(remainingNodes) != 0) || (witness != "" && (len(remainingNodes) != 1 || remainingNodes[0] != witness)) {
		return fmt.Errorf("cluster resources changed during cleanup; preserving ownership witness")
	}
	for _, volume := range remainingVolumes {
		if err := r.verifyResourceOwner(ctx, s, "volume", volume); err != nil {
			return err
		}
	}
	if witness != "" {
		if err := r.verifyResourceOwner(ctx, s, "container", witness); err != nil {
			return err
		}
		if err := r.run(ctx, "k3d", "cluster", "delete", s.Cluster); err != nil {
			return err
		}
	} else {
		// Without nodes k3d cannot discover the cluster's remaining volumes.
		for _, volume := range remainingVolumes {
			if err := r.run(ctx, r.engine, "volume", "rm", volume); err != nil {
				return err
			}
		}
	}
	remains, err := r.clusterResourcesExist(ctx, s.Cluster)
	if err != nil {
		return err
	}
	if remains {
		return fmt.Errorf("cluster %s still has resources after deletion", s.Cluster)
	}
	return nil
}

// Check the whole scope before removing anything. In particular, an owned
// server cannot authorize deletion of an explicitly foreign sibling.
func (r *runner) inspectOwnedCluster(ctx context.Context, s *developmentState) ([]clusterContainer, string, error) {
	nodes, volumes, err := r.clusterResources(ctx, s.Cluster)
	if err != nil {
		return nil, "", err
	}
	for _, volume := range volumes {
		if err := r.verifyResourceOwner(ctx, s, "volume", volume); err != nil {
			return nil, "", err
		}
	}
	containers := make([]clusterContainer, 0, len(nodes))
	witness := ""
	for _, id := range nodes {
		data, err := r.output(ctx, r.engine, "container", "inspect", "--format", "{{json .}}", id)
		if err != nil {
			return nil, "", err
		}
		var container clusterContainer
		if err := json.Unmarshal(data, &container); err != nil {
			return nil, "", fmt.Errorf("invalid cluster container inspection: %w", err)
		}
		if container.ID != id || container.Config.Labels["k3d.cluster"] != s.Cluster {
			return nil, "", fmt.Errorf("cluster container identity changed during cleanup")
		}
		if strings.TrimPrefix(container.Name, "/") == "k3d-"+s.Cluster+"-server-0" && container.Config.Labels[ownershipLabel] == s.Owner {
			witness = id
		}
		containers = append(containers, container)
	}
	for _, container := range containers {
		owner := container.Config.Labels[ownershipLabel]
		if owner == s.Owner {
			continue
		}
		// k3d v5.9 does not pass runtime labels to its tools node. Its native
		// membership is usable only while our owned server remains present.
		if owner != "" || witness == "" || !container.isClusterTools(s, volumes) {
			return nil, "", fmt.Errorf("refusing to delete container %s: ownership label does not match recorded state", container.ID)
		}
	}
	return containers, witness, nil
}

// Only the native fields needed to recognize k3d's unlabeled tools node.
type clusterContainer struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	Mounts []struct {
		Name        string `json:"Name"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
	NetworkSettings struct {
		Networks map[string]any `json:"Networks"`
	} `json:"NetworkSettings"`
}

func (c clusterContainer) isClusterTools(s *developmentState, volumes []string) bool {
	if strings.TrimPrefix(c.Name, "/") != "k3d-"+s.Cluster+"-tools" || c.Config.Labels["app"] != "k3d" || c.Config.Labels["k3d.role"] != "noRole" {
		return false
	}
	if _, ok := c.NetworkSettings.Networks[s.ComposeProject+"_development"]; !ok {
		return false
	}
	imageVolume := "k3d-" + s.Cluster + "-images"
	if !slices.Contains(volumes, imageVolume) {
		return false
	}
	for _, mount := range c.Mounts {
		if mount.Name == imageVolume && mount.Destination == "/k3d/images" {
			return true
		}
	}
	return false
}

func (r *runner) clusterResourcesExist(ctx context.Context, cluster string) (bool, error) {
	exists, err := r.clusterExists(ctx, cluster)
	if err != nil {
		return false, err
	}
	nodes, volumes, err := r.clusterResources(ctx, cluster)
	return exists || len(nodes) > 0 || len(volumes) > 0, err
}

func (r *runner) clusterResources(ctx context.Context, cluster string) ([]string, []string, error) {
	nodes, err := r.output(ctx, r.engine, "ps", "--all", "--quiet", "--no-trunc", "--filter", "label=k3d.cluster="+cluster)
	if err != nil {
		return nil, nil, err
	}
	// Include every volume k3d can select, plus its conventional image volume
	// even if another owner replaced it without k3d labels.
	volumes, err := r.output(ctx, r.engine, "volume", "ls", "--quiet", "--filter", "label=k3d.cluster="+cluster)
	if err != nil {
		return nil, nil, err
	}
	imageVolume := "k3d-" + cluster + "-images"
	named, err := r.output(ctx, r.engine, "volume", "ls", "--quiet", "--filter", "name="+imageVolume)
	if err != nil {
		return nil, nil, err
	}
	result := strings.Fields(string(volumes))
	for _, volume := range strings.Fields(string(named)) {
		if volume == imageVolume && !slices.Contains(result, volume) {
			result = append(result, volume)
		}
	}
	return strings.Fields(string(nodes)), result, nil
}

func (r *runner) verifyResourceOwner(ctx context.Context, s *developmentState, kind, resource string) error {
	labels := ".Config.Labels"
	if kind == "volume" {
		labels = ".Labels"
	}
	label, err := r.output(ctx, r.engine, kind, "inspect", "--format", `{{index `+labels+` "`+ownershipLabel+`"}}`, resource)
	if err != nil {
		return fmt.Errorf("cannot establish ownership of %s %s: %w", kind, resource, err)
	}
	if string(label) != s.Owner {
		return fmt.Errorf("refusing to delete %s %s: ownership label does not match recorded state", kind, resource)
	}
	return nil
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
