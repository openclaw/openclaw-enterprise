// Package occdev owns the local development stack lifecycle.
package occdev

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Options selects the checkout and output destinations for a development command.
type Options struct {
	Repository  string
	KeyOutput   string
	ComposeArgs []string
	Volumes     bool
	Out         io.Writer
	Err         io.Writer
}

type runner struct {
	opts   Options
	env    map[string]string
	engine string
	// automaticNodeResolver is the host upstream resolver that startup chose for
	// the k3d node because OCC_DEVELOPMENT_K3D_DNS_RESOLVER was unset.
	automaticNodeResolver string
	// legacyNATUnconfirmed records that the preflight could not confirm the
	// host's legacy iptables nat table, so a k3d failure names it.
	legacyNATUnconfirmed bool
}

func newRunner(opts Options) *runner {
	if opts.Out == nil {
		opts.Out = io.Discard
	}
	if opts.Err == nil {
		opts.Err = io.Discard
	}
	env := make(map[string]string)
	for _, item := range os.Environ() {
		key, value, _ := strings.Cut(item, "=")
		env[key] = value
	}
	return &runner{opts: opts, env: env}
}
func (r *runner) command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = r.opts.Repository
	for key, value := range r.env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}
func (r *runner) output(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := r.command(ctx, name, args...)
	cmd.Stderr = io.Discard
	data, err := cmd.Output()
	// Never include subprocess output here: bootstrap/config output can contain credentials.
	if err != nil {
		return nil, fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), err)
	}
	return bytes.TrimSpace(data), nil
}
func (r *runner) run(ctx context.Context, name string, args ...string) error {
	cmd := r.command(ctx, name, args...)
	cmd.Stdout = r.opts.Out
	cmd.Stderr = r.opts.Err
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	return nil
}
func (r *runner) compose(ctx context.Context, state *developmentState, args ...string) error {
	return r.run(ctx, r.engine, append(state.composeCommand(), args...)...)
}
func (r *runner) composeOutput(ctx context.Context, state *developmentState, args ...string) ([]byte, error) {
	return r.output(ctx, r.engine, append(state.composeCommand(), args...)...)
}
func (r *runner) selectEngine(ctx context.Context, requested string) error {
	return r.selectContainerEngine(ctx, requested, true)
}

func (r *runner) selectImageEngine(ctx context.Context, requested string) error {
	return r.selectContainerEngine(ctx, requested, false)
}

func (r *runner) selectContainerEngine(ctx context.Context, requested string, requireCompose bool) error {
	if requested != "auto" && requested != "docker" && requested != "podman" {
		return fmt.Errorf("OCC_DEVELOPMENT_CONTAINER_ENGINE must be auto, docker, or podman")
	}
	for _, engine := range []string{"docker", "podman"} {
		if requested != "auto" && requested != engine {
			continue
		}
		if _, err := exec.LookPath(engine); err != nil {
			continue
		}
		if engine == "docker" {
			data, err := r.output(ctx, "docker", "version", "--format", "{{json .Server}}")
			if err != nil {
				continue
			}
			var server struct {
				Platform struct {
					Name string `json:"Name"`
				} `json:"Platform"`
				Components []struct {
					Name string `json:"Name"`
				} `json:"Components"`
			}
			if json.Unmarshal(data, &server) != nil {
				continue
			}
			genuine := strings.Contains(strings.ToLower(server.Platform.Name), "docker")
			for _, component := range server.Components {
				genuine = genuine || component.Name == "Engine"
			}
			if !genuine {
				continue
			}
		}
		if engine == "podman" {
			if requireCompose {
				provider, err := exec.LookPath("podman-compose")
				if err != nil {
					continue
				}
				r.env["PODMAN_COMPOSE_PROVIDER"] = provider
			}
		}
		if _, err := r.output(ctx, engine, "info"); err != nil {
			continue
		}
		if requireCompose {
			if _, err := r.output(ctx, engine, "compose", "version"); err != nil {
				continue
			}
		}
		r.engine = engine
		return nil
	}
	if requireCompose {
		return fmt.Errorf("a running %s container engine with its Compose provider is required", requested)
	}
	return fmt.Errorf("a running %s container engine is required", requested)
}
func (r *runner) pinEndpoint(ctx context.Context) error {
	endpoint := r.env["DOCKER_HOST"]
	if r.engine == "podman" {
		resolved, err := r.podmanEndpoint(ctx)
		if err != nil {
			return err
		}
		endpoint = resolved
	} else if endpoint == "" || r.env["DOCKER_CONTEXT"] != "" {
		selected := r.env["DOCKER_CONTEXT"]
		if selected == "" {
			data, err := r.output(ctx, "docker", "context", "show")
			if err != nil {
				return err
			}
			selected = string(data)
		}
		data, err := r.output(ctx, "docker", "context", "inspect", selected)
		if err != nil {
			return err
		}
		var contexts []struct {
			Endpoints map[string]struct {
				Host string `json:"Host"`
			} `json:"Endpoints"`
		}
		if err := json.Unmarshal(data, &contexts); err != nil || len(contexts) != 1 {
			return fmt.Errorf("could not resolve Docker context endpoint")
		}
		endpoint = contexts[0].Endpoints["docker"].Host
	}
	if !strings.HasPrefix(endpoint, "unix:///") {
		return fmt.Errorf("local Kubernetes development requires a unix container-engine socket")
	}
	r.useEndpoint(endpoint)
	return nil
}

// podmanEndpoint resolves the Podman API socket reachable from this host.
//
// `podman info` reports the socket from the service's own point of view. A
// machine-backed installation runs that service inside a virtual machine, so
// the reported path exists only in the guest and every later k3d, image, and
// cluster call fails to connect. Only `podman machine inspect` records the
// forwarded socket the host can reach, so select that for a remote service.
func (r *runner) podmanEndpoint(ctx context.Context) (string, error) {
	data, err := r.output(ctx, "podman", "info", "--format", "json")
	if err != nil {
		return "", err
	}
	socket, remote, err := parsePodmanInfoSocket(data)
	if err != nil {
		return "", err
	}
	// A successful `podman info` proves an explicitly selected unix endpoint is
	// usable. A named connection outranks it, matching the Podman CLI.
	if r.env["CONTAINER_CONNECTION"] == "" {
		if explicit := unixEndpoint(r.env["CONTAINER_HOST"]); explicit != "" {
			return explicit, nil
		}
	}
	if !remote {
		endpoint := unixEndpoint(socket)
		if endpoint == "" {
			return "", fmt.Errorf("Podman did not report a unix API socket")
		}
		return endpoint, nil
	}
	return r.podmanMachineEndpoint(ctx)
}

func (r *runner) podmanMachineEndpoint(ctx context.Context) (string, error) {
	data, err := r.output(ctx, "podman", "system", "connection", "list", "--format", "json")
	if err != nil {
		return "", err
	}
	var connections []podmanConnection
	if err := json.Unmarshal(data, &connections); err != nil {
		return "", fmt.Errorf("invalid Podman connection inventory: %w", err)
	}
	active := activeMachineConnection(r.env["CONTAINER_CONNECTION"], r.env["CONTAINER_HOST"], connections)
	if active == "" {
		return "", fmt.Errorf("could not identify the active Podman machine connection")
	}
	for _, name := range machineInspectTargets(active) {
		data, err := r.output(ctx, "podman", "machine", "inspect", name)
		if err != nil {
			continue
		}
		if endpoint := unixEndpoint(parsePodmanMachineSocket(data)); endpoint != "" {
			return endpoint, nil
		}
	}
	return "", fmt.Errorf("could not resolve the host API socket for Podman machine %q", active)
}

// podmanConnection is one entry of `podman system connection list`.
type podmanConnection struct {
	Name      string `json:"Name"`
	URI       string `json:"URI"`
	Default   bool   `json:"Default"`
	IsMachine bool   `json:"IsMachine"`
}

func parsePodmanInfoSocket(data []byte) (string, bool, error) {
	var info struct {
		Host struct {
			ServiceIsRemote bool `json:"serviceIsRemote"`
			RemoteSocket    struct {
				Path string `json:"path"`
			} `json:"remoteSocket"`
		} `json:"host"`
	}
	if err := json.Unmarshal(data, &info); err != nil {
		return "", false, fmt.Errorf("invalid Podman engine inventory: %w", err)
	}
	return info.Host.RemoteSocket.Path, info.Host.ServiceIsRemote, nil
}

func parsePodmanMachineSocket(data []byte) string {
	var machines []struct {
		ConnectionInfo struct {
			PodmanSocket struct {
				Path string `json:"Path"`
			} `json:"PodmanSocket"`
		} `json:"ConnectionInfo"`
	}
	if err := json.Unmarshal(data, &machines); err != nil || len(machines) == 0 {
		return ""
	}
	return machines[0].ConnectionInfo.PodmanSocket.Path
}

// activeMachineConnection names the machine whose forwarded socket this host
// should use, following the same precedence as the Podman CLI.
func activeMachineConnection(connection, host string, connections []podmanConnection) string {
	if name := strings.TrimSpace(connection); name != "" {
		return name
	}
	// An explicitly selected endpoint must resolve to its own machine rather
	// than falling back to an unrelated local one.
	if selected := strings.TrimSpace(host); selected != "" {
		for _, candidate := range connections {
			if candidate.IsMachine && candidate.URI == selected {
				return candidate.Name
			}
		}
		return ""
	}
	for _, candidate := range connections {
		if candidate.Default && candidate.IsMachine {
			return candidate.Name
		}
	}
	return "podman-machine-default"
}

// machineInspectTargets lists the names to inspect for a connection. A rootful
// connection appends "-root" to its machine's name, and `podman machine
// inspect` accepts only the machine name.
func machineInspectTargets(connection string) []string {
	targets := []string{connection}
	if machine, found := strings.CutSuffix(connection, "-root"); found && machine != "" {
		targets = append(targets, machine)
	}
	return targets
}

// unixEndpoint normalizes a socket path or unix URL to a DOCKER_HOST value and
// rejects transports, such as ssh, that are not a local socket.
func unixEndpoint(value string) string {
	trimmed := strings.TrimSpace(value)
	if path, found := strings.CutPrefix(trimmed, "unix://"); found {
		trimmed = path
	} else if strings.Contains(trimmed, "://") {
		return ""
	}
	if !strings.HasPrefix(trimmed, "/") {
		return ""
	}
	return "unix://" + trimmed
}

func (r *runner) useEndpoint(endpoint string) {
	delete(r.env, "DOCKER_CONTEXT")
	delete(r.env, "DOCKER_TLS_VERIFY")
	delete(r.env, "DOCKER_CERT_PATH")
	r.env["DOCKER_HOST"] = endpoint
	if r.engine == "podman" {
		r.env["CONTAINER_HOST"] = endpoint
		r.env["CONTAINER_CONNECTION"] = ""
		r.env["OCC_CONTAINER_ENGINE_SOCKET"] = strings.TrimPrefix(endpoint, "unix://")
	}
}
func (r *runner) setting(key, fallback string) string {
	if value := r.env[key]; value != "" {
		return value
	}
	return fallback
}
