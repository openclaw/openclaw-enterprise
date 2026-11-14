//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestComposeBootstrapSQLWithRestrictiveUmask(t *testing.T) {
	if os.Getenv("OCC_TEST_COMPOSE_SQL_UMASK") == "" {
		// Keep the process-wide umask isolated from other tests.
		child := exec.Command(os.Args[0], "-test.run=^TestComposeBootstrapSQLWithRestrictiveUmask$", "-test.v")
		child.Env = append(os.Environ(), "OCC_TEST_COMPOSE_SQL_UMASK=1")
		output, err := child.CombinedOutput()
		t.Logf("%s", output)
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	previous := syscall.Umask(0077)
	defer syscall.Umask(previous)
	for _, tc := range []struct {
		name                                                string
		custom, customAlias, writable, logicalRoot, missing bool
	}{
		{name: "default"},
		{name: "custom source", custom: true},
		{name: "custom symlink to default source", customAlias: true},
		{name: "writable override", writable: true},
		{name: "logical checkout with physical bind", logicalRoot: true},
		{name: "missing SQL with retention and retry", missing: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repository, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(repository, "migrations", "init-local.sql")
			if tc.custom {
				source = filepath.Join(repository, "migrations", "custom.sql")
			}
			if err := os.Mkdir(filepath.Dir(source), 0700); err != nil {
				t.Fatal(err)
			}
			const sql = "-- public bootstrap SQL\nSELECT 1;\n"
			if err := os.WriteFile(source, []byte(sql), 0600); err != nil {
				t.Fatal(err)
			}
			if tc.customAlias {
				alias := filepath.Join(repository, "custom.sql")
				if err := os.Symlink(source, alias); err != nil {
					t.Fatal(err)
				}
				source = alias
			}
			state := filepath.Join(repository, "state")
			captured := filepath.Join(repository, "captured")
			if tc.logicalRoot {
				alias := filepath.Join(t.TempDir(), "checkout")
				if err := os.Symlink(repository, alias); err != nil {
					t.Fatal(err)
				}
				repository = alias
			}
			rendered := fmt.Sprintf(`{"networks":{"development":{"ipam":{"config":[{"subnet":"172.30.0.0/24"}]}}},"services":{"postgres":{"volumes":[{"type":"bind","source":%q,"target":"/docker-entrypoint-initdb.d/00-occ-roles.sql","read_only":%t,"bind":{"selinux":"Z"}}]},"controller":{"ports":["127.0.0.1:4000:3000"]},"worker-kubernetes":{}}}`, source, !tc.writable)
			// Record the real launcher's snapshot at the engine boundary, then fail
			// startup to exercise rollback. This does not simulate PostgreSQL access.
			commands := fakeProfileCommands(t, map[string]string{
				"docker": `
"version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker Engine - Community"}}' ;;
"info"|"compose version"|"info --format "*) ;;
"ps --all --quiet --filter "*|"volume ls --quiet --filter "*|"network ls --quiet --filter "*) ;;
"volume ls --filter "*) ;;
"volume inspect "*|"network inspect "*) exit 1 ;;
"compose --project-name "*" config") echo ` + shellQuote(rendered) + ` ;;
"compose "*" up --build -d postgres migrate bootstrap")
  snapshot=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -f ]; then
      [ -z "$snapshot" ] || exit 42
      shift; snapshot=$1
      [ -n "$snapshot" ] || exit 42
    fi
    shift
  done
  [ "$snapshot" = ` + shellQuote(filepath.Join(state, "compose.yaml")) + ` ] || exit 42
  cp -Rp "$(dirname "$snapshot")" ` + shellQuote(captured) + ` || exit 43
  exit 41 ;;
"compose "*" stop controller worker-kubernetes"|"compose "*" down --volumes") ;;
`,
				"k3d": `"cluster list -o json") echo '[]' ;;`, "kubectl": "", "node": "",
			})
			for key, value := range map[string]string{
				"OCC_DEVELOPMENT_COMPUTE_DRIVER": "kubernetes",
				"OCC_DEVELOPMENT_CONTROL_PLANE":  "compose", "OCC_DEVELOPMENT_SANDBOX_DRIVER": "none",
				"OCC_DEVELOPMENT_CONTAINER_ENGINE": "docker", "DOCKER_HOST": "unix:///run/occ-test/docker.sock",
				"OCC_DEVELOPMENT_STATE_DIRECTORY": state, "OPENCLAW_DEV_PORT": "4000", "OCC_DEVELOPMENT_KUBERNETES_API_PORT": "6443",
				"OCC_DEVELOPMENT_CONTROLLER_IMAGE": "", "OCC_KUBERNETES_RUNTIME_IMAGE": "", "OCC_DEVELOPMENT_KEEP_ON_FAILURE": "",
				"OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY": "", "OCC_DEVELOPMENT_REPOSITORY_IMAGE": "", developmentImageRegistrySetting: "", "DOCKER_CONTEXT": "",
			} {
				t.Setenv(key, value)
			}
			if tc.missing {
				// A failed read must release incomplete state even when inspection
				// retention is enabled, so repairing the source permits a retry.
				t.Setenv("OCC_DEVELOPMENT_KEEP_ON_FAILURE", "1")
				if err := os.Remove(source); err != nil {
					t.Fatal(err)
				}
				err = Up(context.Background(), Options{Repository: repository})
				if err == nil || !strings.Contains(err.Error(), "read Compose bootstrap SQL") {
					t.Fatalf("expected SQL read failure, got %v", err)
				}
				if _, err := os.Stat(state); !os.IsNotExist(err) {
					t.Fatalf("failed preparation stranded state: %v", err)
				}
				if _, err := os.Stat(captured); !os.IsNotExist(err) {
					t.Fatalf("failed preparation reached database startup: %v", err)
				}
				if err := os.WriteFile(source, []byte(sql), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err = Up(context.Background(), Options{Repository: repository})
			if err == nil || !strings.Contains(err.Error(), "exit status 41") {
				t.Fatalf("expected recorded startup failure, got %v; commands: %v", err, commands())
			}
			var snapshot struct {
				Services map[string]struct {
					Volumes []struct {
						Source, Target string
						ReadOnly       bool `yaml:"read_only"`
						Bind           map[string]string
					}
				}
			}
			data, err := os.ReadFile(filepath.Join(captured, "compose.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			if err := yaml.Unmarshal(data, &snapshot); err != nil {
				t.Fatal(err)
			}
			volume := snapshot.Services["postgres"].Volumes[0]
			wantSource := filepath.Join(state, "init-local.sql")
			if tc.custom || tc.customAlias || tc.writable {
				wantSource = source
				if _, err := os.Stat(filepath.Join(captured, "init-local.sql")); !os.IsNotExist(err) {
					t.Fatalf("custom mount created an unnecessary SQL copy: %v", err)
				}
			} else {
				assertBootstrapSQLFile(t, filepath.Join(captured, "init-local.sql"), sql, 0644)
			}
			if volume.Source != wantSource || volume.Target != "/docker-entrypoint-initdb.d/00-occ-roles.sql" || volume.ReadOnly == tc.writable || volume.Bind["selinux"] != "Z" {
				t.Fatalf("unexpected bootstrap mount: %+v", volume)
			}
			if info, err := os.Stat(captured); err != nil || info.Mode().Perm() != 0700 {
				t.Fatalf("state directory lost private permissions: %v (%v)", info, err)
			}
			if tc.missing {
				// Once startup has begun, retention leaves recoverable state and
				// the supported shutdown command removes the owned SQL copy.
				if _, err := readState(state); err != nil {
					t.Fatalf("retained startup state is not recoverable: %v", err)
				}
				if err := Down(context.Background(), Options{Repository: repository}); err != nil {
					t.Fatal(err)
				}
			}
			assertBootstrapSQLFile(t, source, sql, 0600)
			if _, err := os.Stat(state); !os.IsNotExist(err) {
				t.Fatalf("rollback retained owned SQL/state: %v", err)
			}
		})
	}
}

func assertBootstrapSQLFile(t *testing.T, path, contents string, mode os.FileMode) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil || string(data) != contents {
		t.Fatalf("SQL contents changed at %s: %v", path, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != mode {
		t.Fatalf("SQL mode at %s: want %04o, got %v (%v)", path, mode, info, err)
	}
}

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
