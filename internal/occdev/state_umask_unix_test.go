//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

func TestRewriteStateKeepsRecoveryRecordReadableWithRestrictiveUmask(t *testing.T) {
	if directory := os.Getenv("OCC_TEST_STATE_UMASK_DIRECTORY"); directory != "" {
		state, err := readState(directory)
		if err != nil {
			t.Fatal(err)
		}
		// Registry attachment records are replaced after startup created the readable state.
		state.ImageRegistryContainer = "occ-dev-registry"
		state.ImageRegistryNetwork = "k3d-" + state.Cluster
		previous := syscall.Umask(0o400)
		err = rewriteState(state)
		syscall.Umask(previous)
		if err != nil {
			t.Fatal(err)
		}
		// Recovery must read the replaced record even after the restrictive mask is gone.
		recovered, err := readState(directory)
		if err != nil {
			t.Fatalf("recovery cannot read replaced state: %v", err)
		}
		if recovered.ImageRegistryContainer != state.ImageRegistryContainer || recovered.ImageRegistryNetwork != state.ImageRegistryNetwork {
			t.Fatal("recovery lost the recorded registry attachment")
		}
		file, err := os.Open(filepath.Join(directory, "state.json"))
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("state mode = %04o; want 0600", info.Mode().Perm())
		}
		leftovers, err := filepath.Glob(filepath.Join(directory, ".state-*.json"))
		if err != nil || len(leftovers) != 0 {
			t.Fatalf("temporary records = %v: %v", leftovers, err)
		}
		t.Log("native umask 0400: replacement succeeded, recovery read succeeded, state mode 0600, attachment preserved")
		return
	}
	directory := t.TempDir()
	if err := exclusiveWrite(filepath.Join(directory, ".openclaw-development"), []byte(stateMarker), 0o600); err != nil {
		t.Fatal(err)
	}
	state := &developmentState{
		Version: 3, Repository: directory, ComputeDriver: "kubernetes", SandboxDriver: "none",
		DeploymentMode: "k3d", PlatformNamespace: "oce-system", APIPort: 3000,
		ContainerEngine: "docker", Cluster: "occ-dev-recorded", DockerHost: "unix:///recorded-engine.sock",
		KeyPath: filepath.Join(directory, "initial-admin-service-key.json"), KeyOwned: true,
		directory: directory,
	}
	if err := rewriteState(state); err != nil {
		t.Fatal(err)
	}
	// A subprocess isolates the kernel's process-wide umask from other tests.
	child := exec.Command(os.Args[0], "-test.run=^TestRewriteStateKeepsRecoveryRecordReadableWithRestrictiveUmask$", "-test.v")
	child.Env = append(os.Environ(), "OCC_TEST_STATE_UMASK_DIRECTORY="+directory)
	output, err := child.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatalf("state rewrite child: %v", err)
	}
}
