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
			provider, err := exec.LookPath("podman-compose")
			if err != nil {
				continue
			}
			r.env["PODMAN_COMPOSE_PROVIDER"] = provider
		}
		if _, err := r.output(ctx, engine, "info"); err != nil {
			continue
		}
		if _, err := r.output(ctx, engine, "compose", "version"); err != nil {
			continue
		}
		r.engine = engine
		return nil
	}
	return fmt.Errorf("a running %s container engine with its Compose provider is required", requested)
}
func (r *runner) pinEndpoint(ctx context.Context) error {
	endpoint := r.env["DOCKER_HOST"]
	if r.engine == "podman" {
		data, err := r.output(ctx, "podman", "info", "--format", "{{.Host.RemoteSocket.Path}}")
		if err != nil {
			return err
		}
		endpoint = string(data)
		if !strings.HasPrefix(endpoint, "unix://") {
			endpoint = "unix://" + endpoint
		}
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
