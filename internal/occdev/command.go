// Package occdev owns the local development stack lifecycle.
package occdev

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Options selects the checkout and output destinations for a development command.
type Options struct {
	Repository                      string
	KeyOutput                       string
	SandboxNetworkPolicyFile        string
	SandboxNetworkPolicyCeilingFile string
	ComposeArgs                     []string
	Volumes                         bool
	Out                             io.Writer
	Err                             io.Writer
}

type runner struct {
	opts             Options
	env              map[string]string
	engine           string
	composeUnsettled bool
	// automaticNodeResolver is the host upstream resolver that startup chose for
	// the k3d node because OCC_DEVELOPMENT_K3D_DNS_RESOLVER was unset.
	automaticNodeResolver string
	// legacyNATUnconfirmed records that the preflight could not confirm the
	// host's legacy iptables nat table, so a k3d failure names it.
	legacyNATUnconfirmed bool
	// imageRegistry is the loopback registry the k3d node pulls selected
	// images from (OCC_DEVELOPMENT_IMAGE_REGISTRY_CONTAINER); nil without it.
	imageRegistry *developmentImageRegistry
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
		return nil, fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), errors.Join(ctx.Err(), err))
	}
	return bytes.TrimSpace(data), nil
}
func (r *runner) run(ctx context.Context, name string, args ...string) error {
	cmd := r.command(ctx, name, args...)
	cmd.Stdout = r.opts.Out
	cmd.Stderr = r.opts.Err
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, errors.Join(ctx.Err(), err))
	}
	return nil
}
func (r *runner) compose(ctx context.Context, state *developmentState, args ...string) error {
	_, err := r.invokeCompose(ctx, state, false, args...)
	return err
}
func (r *runner) composeOutput(ctx context.Context, state *developmentState, args ...string) ([]byte, error) {
	return r.invokeCompose(ctx, state, true, args...)
}

func (r *runner) invokeCompose(ctx context.Context, state *developmentState, capture bool, args ...string) ([]byte, error) {
	// Cold builds retain their caller's cancellation context without consuming
	// the readiness budget. All startup calls use --no-build after this step.
	if len(args) == 0 || args[0] != "build" {
		bounded, cancel, err := r.composeContext(ctx)
		if err != nil {
			return nil, err
		}
		defer cancel()
		ctx = bounded
	}
	cmd := r.command(ctx, r.engine, append(state.composeCommand(), args...)...)
	finish, err := ownComposeProcessGroup(cmd)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = r.opts.Out, r.opts.Err
	if capture {
		cmd.Stdout, cmd.Stderr = &output, io.Discard
	}
	runErr := cmd.Run()
	groupErr := finish()
	if groupErr != nil {
		// An unconfirmed provider must not race rollback or state removal.
		r.composeUnsettled = true
	}
	if runErr != nil || groupErr != nil {
		return nil, fmt.Errorf("%s Compose failed: %w", r.engine, errors.Join(ctx.Err(), runErr, groupErr))
	}
	return bytes.TrimSpace(output.Bytes()), nil
}

func (r *runner) composeContext(ctx context.Context) (context.Context, context.CancelFunc, error) {
	seconds, err := positiveSetting(r, "OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS", 300, 86400)
	if err != nil {
		return nil, nil, err
	}
	bounded, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	return bounded, cancel, nil
}

func (r *runner) composeServiceID(ctx context.Context, state *developmentState, service string) ([]byte, error) {
	args := []string{"ps", "--all", "--quiet",
		"--filter", "label=com.docker.compose.project=" + state.ComposeProject,
		"--filter", "label=com.docker.compose.service=" + service}
	// Docker Compose labels regular services explicitly. podman-compose 1.5
	// omits the oneoff label; ambiguous Podman matches must still fail closed.
	if r.engine == "docker" {
		args = append(args, "--filter", "label=com.docker.compose.oneoff=False")
	}
	id, err := r.output(ctx, r.engine, args...)
	if err != nil {
		return nil, err
	}
	if len(strings.Fields(string(id))) > 1 {
		return nil, fmt.Errorf("multiple containers found for %s", service)
	}
	return id, nil
}

// selectEngine selects a container engine and Compose provider for startup.
func (r *runner) selectEngine(ctx context.Context, requested string) error {
	return r.selectContainerEngine(ctx, requested, true, composeProvider)
}

// selectDockerComputeEngine selects a container engine for stopping a Docker
// Compute stack. scripts/dev-up starts that stack with standalone
// podman-compose, so occ dev down must pin the same provider: a different
// provider's project labels make its compose down remove nothing.
func (r *runner) selectDockerComputeEngine(ctx context.Context, requested string) error {
	return r.selectContainerEngine(ctx, requested, true, podmanComposeProvider)
}

func (r *runner) selectImageEngine(ctx context.Context, requested string) error {
	return r.selectContainerEngine(ctx, requested, false, nil)
}

func (r *runner) selectContainerEngine(ctx context.Context, requested string, requireCompose bool, provider func() (string, error)) error {
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
			platform := strings.ToLower(server.Platform.Name)
			genuine := strings.Contains(platform, "docker")
			podman := strings.Contains(platform, "podman")
			for _, component := range server.Components {
				genuine = genuine || component.Name == "Engine"
				podman = podman || strings.EqualFold(component.Name, "Podman Engine")
			}
			// Docker CLI formatting can append Engine to a Podman server's components.
			if podman || !genuine {
				continue
			}
		}
		if engine == "podman" {
			if requireCompose {
				found, err := provider()
				if err != nil {
					continue
				}
				r.env["PODMAN_COMPOSE_PROVIDER"] = found
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

// composeProvider resolves the Compose provider Podman's `podman compose`
// delegates to. The Kubernetes-profile Compose command passes
// --project-directory, which standalone podman-compose does not support, so
// prefer docker-compose, which reaches Podman through the DOCKER_HOST endpoint
// startup pins, and keep podman-compose for hosts without it. Up and down must
// agree, or a host with only docker-compose could start a stack it cannot stop.
func composeProvider() (string, error) {
	for _, candidate := range []string{"docker-compose", "podman-compose"} {
		if found, err := exec.LookPath(candidate); err == nil {
			return found, nil
		}
	}
	return "", fmt.Errorf("Podman Compose requires docker-compose or podman-compose on PATH")
}

// podmanComposeProvider resolves the standalone podman-compose provider that
// scripts/dev-up requires and pins for Docker Compute.
func podmanComposeProvider() (string, error) {
	return exec.LookPath("podman-compose")
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
	if r.engine == "podman" {
		data, err := r.output(ctx, "podman", "info", "--format", "json")
		if err != nil {
			return fmt.Errorf("Podman API socket is not reachable; start the selected Podman socket service: %w", err)
		}
		socket, _, err := parsePodmanInfoSocket(data)
		if err != nil || unixEndpoint(socket) == "" {
			return fmt.Errorf("Podman API did not report an absolute engine-host socket path")
		}
		// API clients use the host-reachable endpoint; bind mounts are resolved
		// on the engine host, which can differ for a Podman machine.
		r.env["DOCKER_SOCK"] = strings.TrimPrefix(unixEndpoint(socket), "unix://")
		r.env["OCC_CONTAINER_ENGINE_SOCKET"] = r.env["DOCKER_SOCK"]
	}
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
