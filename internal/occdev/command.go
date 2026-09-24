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
	"path/filepath"
	"strings"
	"time"
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
	opts      Options
	env       map[string]string
	engine    string
	lifecycle bool
	unsettled bool
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
	cmd.WaitDelay = 250 * time.Millisecond
	ownCommand(cmd)
	cmd.Dir = r.opts.Repository
	for key, value := range r.env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}
func (r *runner) output(ctx context.Context, name string, args ...string) ([]byte, error) {
	if r.unsettled {
		return nil, fmt.Errorf("subprocess outcome is uncertain")
	}
	cmd := r.command(ctx, name, args...)
	data, settled, err := capturedOutput(cmd)
	r.recordCommandOutcome(ctx, cmd, err, false, settled)
	// Never include subprocess output here: bootstrap/config output can contain credentials.
	if err != nil {
		return nil, fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), err)
	}
	return bytes.TrimSpace(data), nil
}

// Own the captured pipe so its EOF is independent of Wait's exit error.
// Cmd.Wait can hide ErrWaitDelay behind a nonzero process exit.
func capturedOutput(cmd *exec.Cmd) ([]byte, bool, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, true, err
	}
	defer reader.Close()
	cmd.Stdout = writer
	err = cmd.Start()
	writer.Close()
	if err != nil {
		return nil, true, err
	}
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(reader)
		done <- result{data, err}
	}()
	err = cmd.Wait()
	timer := time.NewTimer(cmd.WaitDelay)
	defer timer.Stop()
	select {
	case output := <-done:
		return output.data, output.err == nil, errors.Join(err, output.err)
	case <-timer.C:
		reader.Close()
		<-done
		return nil, false, errors.Join(err, exec.ErrWaitDelay)
	}
}

// run is for commands that can change engine resources or local lifecycle files.
func (r *runner) run(ctx context.Context, name string, args ...string) error {
	if r.unsettled {
		return fmt.Errorf("subprocess outcome is uncertain")
	}
	cmd := r.command(ctx, name, args...)
	cmd.Stdout = r.opts.Out
	cmd.Stderr = r.opts.Err
	err := cmd.Run()
	r.recordCommandOutcome(ctx, cmd, err, true, !errors.Is(err, exec.ErrWaitDelay))
	if err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	return nil
}
func (r *runner) recordCommandOutcome(ctx context.Context, cmd *exec.Cmd, err error, mutates, outputSettled bool) {
	if cmd.Process == nil || err == nil {
		return
	}
	// A failed mutation needs independent settlement evidence before recovery.
	// Read-only probes may fail normally, but require a normal process exit and
	// fully drained output. Neither a signal nor a closed pipe proves settlement.
	if !mutates && ctx.Err() == nil && outputSettled && cmd.ProcessState != nil && cmd.ProcessState.Exited() {
		return
	}
	// WaitDelay can expire after the direct child exits. Its remaining group
	// still belongs to this command, even though the direct child is reaped.
	_ = cmd.Cancel()
	if r.lifecycle {
		r.unsettled = true
	}
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
			platform, _ := r.output(ctx, "docker", "version", "--format", "{{.Server.Platform.Name}}")
			if string(platform) == "Podman Engine" {
				continue
			}
			root, err := r.output(ctx, "docker", "info", "--format", "{{.DockerRootDir}}")
			if err != nil || len(root) == 0 {
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
		if engine == "docker" {
			if err := r.dockerComposeCapability(ctx); err != nil {
				continue
			}
		}
		r.engine = engine
		return nil
	}
	return fmt.Errorf("a running %s container engine with its Compose provider is required", requested)
}

func (r *runner) dockerComposeCapability(ctx context.Context) error {
	directory, err := os.MkdirTemp("", "occ-compose-capability-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	path := filepath.Join(directory, "compose-capability.yaml")
	if err := exclusiveWrite(path, []byte("services:\n  probe:\n    image: busybox:latest\n"), 0600); err != nil {
		return err
	}
	_, err = r.output(ctx, "docker", "compose", "-f", path, "config", "--format", "json")
	return err
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
	if canonical, err := filepath.EvalSymlinks(strings.TrimPrefix(endpoint, "unix://")); err == nil {
		endpoint = "unix://" + canonical
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
