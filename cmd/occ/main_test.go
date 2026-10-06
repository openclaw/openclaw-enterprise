package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if arguments, ok := os.LookupEnv("OCC_TEST_RUN_MAIN"); ok {
		os.Args = append([]string{"occ"}, strings.Fields(arguments)...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// occ dev up on the Docker profile runs scripts/dev-up; its exit status is the
// command's, so callers can tell success, failure and the script's usage
// errors (exit 2) apart.
func TestDevUpDockerExitsWithTheStartupScriptStatus(t *testing.T) {
	for _, code := range []int{0, 3} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			repository := t.TempDir()
			for path, contents := range map[string]string{
				"go.mod":         "module github.com/openclaw/openclaw-enterprise\n",
				"compose.yaml":   "services: {}\n",
				"scripts/dev-up": "echo started\nexit " + strconv.Itoa(code) + "\n",
			} {
				path = filepath.Join(repository, path)
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			process := exec.Command(executable)
			process.Dir = repository
			process.Env = append(os.Environ(), "OCC_TEST_RUN_MAIN=dev up", "OCC_DEVELOPMENT_COMPUTE_DRIVER=docker")
			var stderr strings.Builder
			process.Stderr = &stderr
			err = process.Run()
			status := 0
			var exited *exec.ExitError
			if errors.As(err, &exited) {
				status = exited.ExitCode()
			} else if err != nil {
				t.Fatal(err)
			}
			if status != code {
				t.Fatalf("occ dev up exited %d, want the script's %d; stderr: %q", status, code, stderr.String())
			}
			if stderr.String() != "" {
				t.Fatalf("occ dev up added to the script's diagnostics: %q", stderr.String())
			}
		})
	}
}
