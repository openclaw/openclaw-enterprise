package occcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDevelopmentRepository(t *testing.T) {
	const declaration = "module github.com/openclaw/openclaw-enterprise"
	const genericError = "run occ dev from an OpenClaw Enterprise source checkout"
	for _, test := range []struct {
		name       string
		module     string
		hasCompose bool
		hasCRLF    bool
		wantError  string
	}{
		{name: "LF ancestor", module: declaration + "\n", hasCompose: true},
		{name: "CRLF marker", module: declaration + "\r\n", hasCompose: true, hasCRLF: true},
		{name: "mixed line endings", module: declaration + "\n\r\ngo 1.27\r\n", hasCompose: true, hasCRLF: true},
		{name: "other CRLF module", module: declaration + "-other\r\n", hasCompose: true, wantError: genericError},
		{name: "CRLF without Compose", module: declaration + "\r\n", wantError: genericError},
		{name: "no terminating newline", module: declaration, hasCompose: true, wantError: genericError},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := t.TempDir()
			modulePath := filepath.Join(repository, "go.mod")
			if err := os.WriteFile(modulePath, []byte(test.module), 0o600); err != nil {
				t.Fatal(err)
			}
			if test.hasCompose {
				if err := os.WriteFile(filepath.Join(repository, "compose.yaml"), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			subdirectory := filepath.Join(repository, "subdirectory")
			if err := os.Mkdir(subdirectory, 0o700); err != nil {
				t.Fatal(err)
			}
			t.Chdir(subdirectory)

			got, err := developmentRepository()
			wantError := test.wantError
			if test.hasCRLF {
				wantError = fmt.Sprintf("%q uses CRLF line endings; convert it to LF before running occ dev", modulePath)
			}
			if wantError != "" {
				if got != "" || err == nil || err.Error() != wantError {
					t.Fatalf("developmentRepository() = %q, %v; want no path and %q", got, err, wantError)
				}
				return
			}
			if err != nil || got != repository {
				t.Fatalf("developmentRepository() = %q, %v; want %q", got, err, repository)
			}
		})
	}
}

func TestDevelopmentRepositoryComposeMarker(t *testing.T) {
	const module = "module github.com/openclaw/openclaw-enterprise\n"
	for _, marker := range []string{"regular file", "symlink to regular file", "missing", "directory"} {
		t.Run(marker, func(t *testing.T) {
			outer := t.TempDir()
			inner := filepath.Join(outer, "nested")
			if err := os.Mkdir(inner, 0o700); err != nil {
				t.Fatal(err)
			}
			for _, directory := range []string{outer, inner} {
				if err := os.WriteFile(filepath.Join(directory, "go.mod"), []byte(module), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			outerCompose := filepath.Join(outer, "compose.yaml")
			if err := os.WriteFile(outerCompose, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			innerCompose := filepath.Join(inner, "compose.yaml")
			want := inner
			switch marker {
			case "regular file":
				if err := os.WriteFile(innerCompose, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink to regular file":
				if err := os.Symlink(outerCompose, innerCompose); err != nil {
					t.Fatal(err)
				}
			case "missing":
				want = outer
			case "directory":
				if err := os.Mkdir(innerCompose, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			t.Chdir(inner)
			got, err := developmentRepository()
			if marker == "directory" {
				wantError := fmt.Sprintf("%q must be a regular file", innerCompose)
				if got != "" || err == nil || err.Error() != wantError {
					t.Fatalf("developmentRepository() = %q, %v; want no path and %q", got, err, wantError)
				}
				return
			}
			if err != nil || got != want {
				t.Fatalf("developmentRepository() = %q, %v; want %q", got, err, want)
			}
		})
	}
}

func TestDevRefusesNearestInvalidCheckout(t *testing.T) {
	const declaration = "module github.com/openclaw/openclaw-enterprise"
	for _, test := range []struct {
		name          string
		module        string
		composeMarker string
	}{
		{name: "CRLF", module: declaration + "\r\n"},
		{name: "mixed endings", module: declaration + "\n\r\ngo 1.27.3\r\n"},
		{name: "Compose directory", module: declaration + "\n", composeMarker: "directory"},
		{name: "dangling Compose symlink", module: declaration + "\n", composeMarker: "dangling"},
		{name: "looping Compose symlink", module: declaration + "\n", composeMarker: "loop"},
	} {
		for _, args := range [][]string{{"dev", "up"}, {"dev", "down", "--volumes"}} {
			t.Run(test.name+"/"+args[1], func(t *testing.T) {
				repository := t.TempDir()
				nested := filepath.Join(repository, "nested")
				if err := os.Mkdir(nested, 0o700); err != nil {
					t.Fatal(err)
				}
				// The outer checkout is valid, but must never receive the inner
				// checkout's startup or destructive cleanup command.
				for directory, content := range map[string]string{repository: declaration + "\n", nested: test.module} {
					if err := os.WriteFile(filepath.Join(directory, "go.mod"), []byte(content), 0o600); err != nil {
						t.Fatal(err)
					}
					composePath := filepath.Join(directory, "compose.yaml")
					if directory == nested && test.composeMarker == "directory" {
						if err := os.Mkdir(composePath, 0o700); err != nil {
							t.Fatal(err)
						}
					} else if directory == nested && (test.composeMarker == "dangling" || test.composeMarker == "loop") {
						target := "missing.yaml"
						if test.composeMarker == "loop" {
							target = "compose.yaml"
						}
						if err := os.Symlink(target, composePath); err != nil {
							t.Fatal(err)
						}
					} else if err := os.WriteFile(composePath, nil, 0o600); err != nil {
						t.Fatal(err)
					}
				}
				t.Chdir(nested)
				// Keep an accidental dispatch from reaching host tools. This
				// does not replace repository discovery or the CLI command tree.
				t.Setenv("PATH", t.TempDir())
				t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker")
				t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
				t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", "")
				var output bytes.Buffer
				command := New(&output, &output)
				command.SetArgs(args)
				err := command.Execute()
				want := fmt.Sprintf("%q uses CRLF line endings; convert it to LF before running occ dev", filepath.Join(nested, "go.mod"))
				if test.composeMarker == "directory" {
					want = fmt.Sprintf("%q must be a regular file", filepath.Join(nested, "compose.yaml"))
				}
				if test.composeMarker == "dangling" || test.composeMarker == "loop" {
					want = fmt.Sprintf("inspect %q:", filepath.Join(nested, "compose.yaml"))
					if err == nil || !strings.HasPrefix(err.Error(), want) {
						t.Fatalf("%v: got %v; want nearest-checkout refusal starting with %q", args, err, want)
					}
				} else if err == nil || err.Error() != want {
					t.Fatalf("%v: got %v; want nearest-checkout refusal %q", args, err, want)
				}
			})
		}
	}
}

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
		{"empty", []string{"OCC_DEVELOPMENT_PROTECTED_EGRESS="}, ""},
		{"disabled", []string{"OCC_DEVELOPMENT_PROTECTED_EGRESS=0"}, ""},
		{"enabled", []string{"OCC_DEVELOPMENT_PROTECTED_EGRESS=1"}, "OCC_DEVELOPMENT_PROTECTED_EGRESS=1 is retired; unset it or set it to 0 for ordinary development. This does not convert an existing installation; use occ dev down for cleanup."},
		{"invalid", []string{"OCC_DEVELOPMENT_PROTECTED_EGRESS=true"}, "OCC_DEVELOPMENT_PROTECTED_EGRESS must be unset, empty, or set to 0"},
		{"database", []string{"OCC_DEVELOPMENT_DATABASE_NAME=openclaw_k8s_owned"}, "OCC_DEVELOPMENT_DATABASE_NAME requires"},
		{"empty-database", []string{"OCC_DEVELOPMENT_DATABASE_NAME="}, "OCC_DEVELOPMENT_DATABASE_NAME requires"},
		{"host-gateway", []string{"OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP=172.30.42.1"}, "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP is retired; remove this setting"},
		{"empty-host-gateway", []string{"OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP="}, "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP is retired; remove this setting"},
	}
	for _, entrypoint := range []string{"cli", "script"} {
		for _, compute := range []string{"default", "docker", "kubernetes"} {
			for _, scenario := range cases {
				// Database and ordinary-launch controls below exercise Docker;
				// Kubernetes additionally covers the formerly supported profile.
				if compute == "kubernetes" && (scenario.want == "" || strings.Contains(scenario.name, "database")) {
					continue
				}
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
					if compute != "default" {
						command.Env = append(command.Env, "OCC_DEVELOPMENT_COMPUTE_DRIVER="+compute)
					}
					if compute == "kubernetes" {
						command.Env = append(command.Env, "OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes", "OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell")
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
