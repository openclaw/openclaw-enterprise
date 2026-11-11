package occdev

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"go.yaml.in/yaml/v3"
)

// Check verifies the provisioning dependency of a recorded managed development
// stack. It does not certify running Agents, model access, or external services.
func Check(ctx context.Context, opts Options) error {
	r := newRunner(opts)
	if selected := r.env["OCC_DEVELOPMENT_COMPUTE_DRIVER"]; selected != "" && selected != "kubernetes" {
		return fmt.Errorf("occ dev check requires recorded Kubernetes Local Setup state")
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
	if !sameCheckout(state.Repository, opts.Repository) {
		return fmt.Errorf("Local Setup state belongs to another checkout; run occ dev check from its recorded repository")
	}
	if state.SandboxDriver == "none" {
		fmt.Fprintln(r.opts.Out, "No OpenShell provisioning dependency is configured; Agent and model readiness were not checked.")
		return nil
	}
	kubeconfig := filepath.Join(directory, "kubeconfig")
	if err := checkDevelopmentKubeconfig(kubeconfig, state.Cluster); err != nil {
		return err
	}
	r.env["KUBECONFIG"] = kubeconfig
	// Keep a bounded check separate from the longer initial installation wait.
	// A failed dependency must not consume the first-Agent activation deadline.
	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	err = r.run(checkCtx, "kubectl", "rollout", "status", "deployment/"+agentSandboxName,
		"--namespace", agentSandboxNamespace, "--timeout=10s", "--request-timeout=10s",
		"--kubeconfig", kubeconfig, "--context", "k3d-"+state.Cluster)
	if err == nil {
		observed := r.agentSandboxRead(checkCtx, state, "deployment", agentSandboxDeploymentTemplate, 1)
		// A scaled-to-zero Deployment can have a completed rollout without a
		// controller capable of creating the workload Pod.
		if observed.Status != "ok" || len(observed.Items) != 1 || !agentSandboxDeploymentValid(observed.Items[0]) ||
			observed.Items[0].ReadyReplicas < 1 || observed.Items[0].AvailableReplicas < 1 {
			err = fmt.Errorf("the recorded Agent Sandbox controller has no verified ready replica")
		}
	}
	if err != nil {
		fmt.Fprintln(r.opts.Err, "Agent Sandbox controller is unavailable; inspect its rollout and image-pull status.")
		r.captureAgentSandboxRollout(state)
		return fmt.Errorf("Agent Sandbox controller is unavailable; inspect its rollout and image-pull status in %s, restore it, then retry the same first-Agent command: %w", agentSandboxNamespace, err)
	}
	fmt.Fprintln(r.opts.Out, "Agent Sandbox controller is ready. Agent and model readiness were not checked.")
	return nil
}

func checkDevelopmentKubeconfig(path, cluster string) error {
	if err := privateOwned(path, false); err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var config struct {
		CurrentContext string `yaml:"current-context"`
		Contexts       []struct {
			Name    string `yaml:"name"`
			Context struct {
				Cluster string `yaml:"cluster"`
			} `yaml:"context"`
		} `yaml:"contexts"`
		Clusters []struct {
			Name    string `yaml:"name"`
			Cluster struct {
				Server string `yaml:"server"`
			} `yaml:"cluster"`
		} `yaml:"clusters"`
	}
	if yaml.Unmarshal(data, &config) != nil || config.CurrentContext != "k3d-"+cluster {
		return fmt.Errorf("recorded Kubernetes context does not match Local Setup")
	}
	selected := ""
	for _, item := range config.Contexts {
		if item.Name == config.CurrentContext {
			selected = item.Context.Cluster
		}
	}
	for _, item := range config.Clusters {
		if selected != "" && item.Name == selected {
			server, err := url.Parse(item.Cluster.Server)
			if err == nil && server.Scheme == "https" && server.User == nil && server.RawQuery == "" && server.Fragment == "" && (server.Path == "" || server.Path == "/") &&
				(server.Hostname() == "localhost" || net.ParseIP(server.Hostname()).IsLoopback()) {
				return nil
			}
		}
	}
	return fmt.Errorf("recorded Kubernetes endpoint must be an HTTPS loopback origin")
}
