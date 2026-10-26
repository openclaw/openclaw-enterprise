package occcli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDevUpRejectsSandboxPolicyFlagsBeforeDockerStartup(t *testing.T) {
	repository, err := developmentRepository()
	if err != nil {
		t.Fatal(err)
	}
	// Pin every selector so a developer's exported settings cannot stop the script before usage.
	dockerEnv := []string{"OCC_DEVELOPMENT_COMPUTE_DRIVER=docker", "OCC_DEVELOPMENT_SANDBOX_DRIVER=none", "OCC_DEVELOPMENT_CONTROL_PLANE="}
	for _, args := range [][]string{
		{"--sandbox-network-policy-file", "/tmp/policy.yaml"},
		{"--sandbox-network-policy-ceiling-file=/tmp/ceiling.yaml"},
	} {
		command := exec.Command("bash", append([]string{"scripts/dev-up"}, args...)...)
		command.Dir = repository
		command.Env = append(os.Environ(), dockerEnv...)
		output, err := command.CombinedOutput()
		var exited *exec.ExitError
		if !errors.As(err, &exited) || exited.ExitCode() != 2 {
			t.Fatalf("%v: err = %v\n%s", args, err, output)
		}
		text := string(output)
		if !strings.Contains(text, "Sandbox policy input requires Kubernetes Compute and a Sandbox Driver") || strings.Contains(text, "unknown option") {
			t.Fatalf("%v:\n%s", args, text)
		}
		// Finding 2323: the usage printed after the refusal must not offer the refused flags.
		if !strings.Contains(text, "usage: scripts/dev-up") || strings.Contains(text, "--sandbox-network-policy") {
			t.Fatalf("%v: usage offers Kubernetes-only flags:\n%s", args, text)
		}
	}
	help := exec.Command("bash", "scripts/dev-up", "--help")
	help.Dir = repository
	help.Env = append(os.Environ(), dockerEnv...)
	output, err := help.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "usage: scripts/dev-up") || strings.Contains(string(output), "--sandbox-network-policy") {
		t.Fatalf("--help: err = %v\n%s", err, output)
	}
}

func TestDevUpProtectedProfileEntrypoints(t *testing.T) {
	repository, err := developmentRepository()
	if err != nil {
		t.Fatal(err)
	}
	fixture := t.TempDir()
	for _, directory := range []string{"bin", "scripts", "tools"} {
		if err := os.Mkdir(filepath.Join(fixture, directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// Keep the actual script and CLI together so direct shell entry exercises the
	// same validation as occ dev up, without a replacement validation fixture.
	for _, path := range []string{"go.mod", "compose.yaml", "scripts/dev-up"} {
		data, err := os.ReadFile(filepath.Join(repository, path))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(fixture, path), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cli := filepath.Join(fixture, "bin", "occ")
	build := exec.Command("go", "build", "-o", cli, "./cmd/occ")
	build.Dir = repository
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	tools := filepath.Join(fixture, "tools")
	for _, name := range []string{"dirname", "python3", "mktemp", "chmod", "rm"} {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(path, filepath.Join(tools, name)); err != nil {
			t.Fatal(err)
		}
	}
	// Record dispatch separately from infrastructure access: a missing CLI guard
	// must fail even if the real script would subsequently reject the selection.
	for name, body := range map[string]string{
		"bash":   "#!/bin/bash\nprintf 'script dispatched\\n' >>\"$DISPATCH_LOG\"\nexec /bin/bash \"$@\"\n",
		"docker": "#!/bin/bash\nprintf '%s\\n' \"$*\" >>\"$ENGINE_LOG\"\nexit 1\n",
	} {
		if err := os.WriteFile(filepath.Join(tools, name), []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name     string
		settings []string
		want     string
	}{
		{"unset", nil, ""},
		{"disabled", []string{"OCC_DEVELOPMENT_PROTECTED_EGRESS=0"}, ""},
		{"enabled", []string{"OCC_DEVELOPMENT_PROTECTED_EGRESS=1"}, "protected egress requires"},
		{"invalid", []string{"OCC_DEVELOPMENT_PROTECTED_EGRESS=true"}, "OCC_DEVELOPMENT_PROTECTED_EGRESS must be 0 or 1"},
		{"database", []string{"OCC_DEVELOPMENT_DATABASE_NAME=openclaw_k8s_owned"}, "OCC_DEVELOPMENT_DATABASE_NAME requires"},
		{"empty-database", []string{"OCC_DEVELOPMENT_DATABASE_NAME="}, "OCC_DEVELOPMENT_DATABASE_NAME requires"},
		{"host-gateway", []string{"OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP=172.30.42.1"}, "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP requires"},
		{"empty-host-gateway", []string{"OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP="}, "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP requires"},
	}
	for _, entrypoint := range []string{"cli", "script"} {
		for _, compute := range []string{"default", "docker"} {
			for _, scenario := range cases {
				t.Run(entrypoint+"/"+compute+"/"+scenario.name, func(t *testing.T) {
					directory := t.TempDir()
					// The real launcher requires a private bootstrap-key parent,
					// independently of the test runner's umask.
					if err := os.Chmod(directory, 0o700); err != nil {
						t.Fatal(err)
					}
					engineLog := filepath.Join(directory, "engine.log")
					dispatchLog := filepath.Join(directory, "dispatch.log")
					key := filepath.Join(directory, "key.json")
					args := []string{"--key-output", key}
					command := exec.Command(cli, append([]string{"dev", "up"}, args...)...)
					if entrypoint == "script" {
						command = exec.Command("/bin/bash", append([]string{"scripts/dev-up"}, args...)...)
					}
					command.Dir = fixture
					command.Env = append([]string{
						"PATH=" + tools, "TMPDIR=" + directory,
						"ENGINE_LOG=" + engineLog, "DISPATCH_LOG=" + dispatchLog,
						"OCC_DEVELOPMENT_CONTAINER_ENGINE=docker",
					}, scenario.settings...)
					if compute == "docker" {
						command.Env = append(command.Env, "OCC_DEVELOPMENT_COMPUTE_DRIVER=docker")
					}
					output, err := command.CombinedOutput()
					t.Logf("exit: %v; output: %s", err, output)
					if err == nil {
						t.Fatal("startup must stop at validation or the unavailable Docker probe")
					}
					engineCalls, readErr := os.ReadFile(engineLog)
					if scenario.want == "" {
						// Ordinary profiles must reach the existing engine selection;
						// this probe deliberately supplies no Docker daemon.
						if readErr != nil || !strings.Contains(string(engineCalls), "version --format {{json .Server}}") {
							t.Fatalf("ordinary Docker profile did not reach engine selection: %v, %s", readErr, engineCalls)
						}
					} else {
						if !strings.Contains(string(output), scenario.want) {
							t.Errorf("missing validation diagnostic %q", scenario.want)
						}
						if !os.IsNotExist(readErr) {
							t.Errorf("rejected profile reached infrastructure helper: %v, %s", readErr, engineCalls)
						}
						if _, err := os.Stat(dispatchLog); !os.IsNotExist(err) {
							t.Errorf("rejected profile dispatched startup script: %v", err)
						}
					}
					if _, err := os.Stat(key); !os.IsNotExist(err) {
						t.Errorf("startup wrote bootstrap key: %v", err)
					}
				})
			}
		}
	}
}

func TestDevUpRejectsUnsupportedOrEmptySandboxPolicyFlag(t *testing.T) {
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker")
	for _, test := range []struct{ value, message string }{
		{"", "must name a Sandbox network policy file"},
		{"policy.yaml", "requires Kubernetes Compute"},
	} {
		command := New(&bytes.Buffer{}, &bytes.Buffer{})
		command.SetArgs([]string{"dev", "up", "--sandbox-network-policy-file=" + test.value})
		if err := command.Execute(); err == nil || !strings.Contains(err.Error(), test.message) {
			t.Fatalf("expected %q, got %v", test.message, err)
		}
	}
}

func TestDevUpRejectsEmptySandboxPolicyCeilingFlag(t *testing.T) {
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker")
	command := New(&bytes.Buffer{}, &bytes.Buffer{})
	command.SetArgs([]string{"dev", "up", "--sandbox-network-policy-ceiling-file="})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "--sandbox-network-policy-ceiling-file must name a Sandbox network policy ceiling file") {
		t.Fatalf("empty ceiling file = %v", err)
	}
}

// Interrupting occ dev up must let scripts/dev-up run its EXIT trap, which
// removes the private temporary directory holding the rendered Compose
// configuration (with interpolated development secrets).
func TestDevUpInterruptLetsTheStartupScriptCleanUp(t *testing.T) {
	repository := t.TempDir()
	marker := filepath.Join(repository, "trap-ran")
	started := filepath.Join(repository, "started")
	// The TERM trap exits 143, a plain status like a script that handles the
	// signal, so an interrupt must not be mistaken for the script's own failure.
	script := "trap 'touch \"$TRAP_MARKER\"' EXIT\ntrap 'kill $!; exit 143' TERM\n: >\"$STARTED_MARKER\"\nsleep 30 >/dev/null 2>&1 &\nwait $!\n"
	for path, contents := range map[string]string{
		"go.mod":         "module github.com/openclaw/openclaw-enterprise\n",
		"compose.yaml":   "services: {}\n",
		"scripts/dev-up": script,
	} {
		path = filepath.Join(repository, path)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(repository)
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker")
	t.Setenv("TRAP_MARKER", marker)
	t.Setenv("STARTED_MARKER", started)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(started); err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		cancel()
	}()

	command := New(&bytes.Buffer{}, &bytes.Buffer{})
	command.SetArgs([]string{"dev", "up"})
	begin := time.Now()
	err := command.ExecuteContext(ctx)
	if err == nil {
		t.Fatal("interrupted occ dev up exited successfully")
	}
	// An interrupt is reported as one, not as the script's own exit status.
	var status *ExitStatusError
	if errors.As(err, &status) {
		t.Fatalf("interrupted occ dev up passed on the script status %d", status.Code)
	}
	if elapsed := time.Since(begin); elapsed > 25*time.Second {
		t.Fatalf("occ dev up took %s to stop after the interrupt", elapsed)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("scripts/dev-up EXIT trap did not run after the interrupt: %v", err)
	}
}
