package occdev

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

const (
	legacyNATTestRelease  = "6.8.0-41-generic"
	legacyNATTestHostname = "devhost"
	legacyNATTestModules  = "lib/modules/" + legacyNATTestRelease + "/"
	legacyNATTestDep      = "kernel/net/ipv4/netfilter/ip_tables.ko.zst: kernel/net/netfilter/x_tables.ko.zst\n" +
		"kernel/net/ipv4/netfilter/iptable_nat.ko.zst: kernel/net/netfilter/nf_nat.ko.zst kernel/net/ipv4/netfilter/ip_tables.ko.zst\n"
	legacyNATTestBuiltin = "kernel/net/netfilter/x_tables.ko\n"
	// An nftables host: x_tables is loaded through nft_compat, ip_tables is not.
	legacyNATTestNFTModules = "nft_compat 20480 4 - Live 0x0\nx_tables 65536 6 nft_compat, Live 0x0\nnf_nat 65536 1 - Live 0x0\n"
)

func legacyNATTestFiles(files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{
		"proc/sys/kernel/osrelease": {Data: []byte(legacyNATTestRelease + "\n")},
		"proc/sys/kernel/hostname":  {Data: []byte(legacyNATTestHostname + "\n")},
	}
	for name, data := range files {
		fsys[name] = &fstest.MapFile{Data: []byte(data)}
	}
	return fsys
}

// legacyNATUnloadableHost is the reported failure: the kernel ships the
// legacy modules, but nothing loaded ip_tables, so the node cannot reach them.
var legacyNATUnloadableHost = map[string]string{
	"proc/modules":                           legacyNATTestNFTModules,
	legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
	legacyNATTestModules + "modules.dep":     legacyNATTestDep,
}

func withLegacyNATFiles(base map[string]string, extra map[string]string) map[string]string {
	files := make(map[string]string, len(base)+len(extra))
	for name, data := range base {
		files[name] = data
	}
	for name, data := range extra {
		files[name] = data
	}
	return files
}

// rootOnlyFS refuses to open one file but still reports it, like the
// root-only /proc/net/ip_tables_names seen by an ordinary user.
type rootOnlyFS struct {
	fstest.MapFS
	name string
}

func (f rootOnlyFS) Open(name string) (fs.File, error) {
	if name == f.name {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrPermission}
	}
	return f.MapFS.Open(name)
}

func (f rootOnlyFS) ReadFile(name string) ([]byte, error) {
	if name == f.name {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrPermission}
	}
	return f.MapFS.ReadFile(name)
}

func (f rootOnlyFS) Stat(name string) (fs.FileInfo, error) {
	return f.MapFS.Stat(name)
}

func TestLegacyNATTableStateTreatsTheRootOnlyTablesFileAsPresent(t *testing.T) {
	files := legacyNATTestFiles(withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{
		"proc/net/ip_tables_names": "filter\n",
	}))
	fsys := rootOnlyFS{MapFS: files, name: "proc/net/ip_tables_names"}
	if _, err := fs.ReadFile(fsys, "proc/net/ip_tables_names"); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("fixture is readable: %v", err)
	}
	if got := legacyNATTableState(fsys, legacyNATTestRelease); got != legacyNATAvailable {
		t.Fatalf("got %v, want available: ip_tables is present", got)
	}
}

func TestLegacyNATTableState(t *testing.T) {
	for _, test := range []struct {
		name    string
		files   map[string]string
		release string
		want    legacyNATState
	}{
		{"nat module in sysfs", map[string]string{"sys/module/iptable_nat/refcnt": "1\n"}, legacyNATTestRelease, legacyNATAvailable},
		{"nat module in proc", map[string]string{"proc/modules": "nf_nat 65536 1 - Live 0x0\niptable_nat 12288 0 - Live 0x0\n"}, legacyNATTestRelease, legacyNATAvailable},
		{"nat table registered", map[string]string{"proc/net/ip_tables_names": "filter\nnat\n"}, legacyNATTestRelease, legacyNATAvailable},
		// Built-in modules appear in neither /proc/modules nor, without
		// parameters, /sys/module.
		{"nat built into the kernel", map[string]string{
			legacyNATTestModules + "modules.builtin": "kernel/net/ipv4/netfilter/ip_tables.ko\nkernel/net/ipv4/netfilter/iptable_nat.ko\n",
			legacyNATTestModules + "modules.dep":     "",
		}, legacyNATTestRelease, legacyNATAvailable},
		// With ip_tables present, the kernel loads iptable_nat when the node
		// first asks for the nat table (the hosted CI runners work this way).
		{"ip_tables loaded", withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{
			"proc/modules": legacyNATTestNFTModules + "ip_tables 36864 1 iptable_filter, Live 0x0\n",
		}), legacyNATTestRelease, legacyNATAvailable},
		{"ip_tables in sysfs", withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{
			"sys/module/ip_tables/refcnt": "1\n",
		}), legacyNATTestRelease, legacyNATAvailable},
		{"filter table only", withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{
			"proc/net/ip_tables_names": "filter\n",
		}), legacyNATTestRelease, legacyNATAvailable},
		{"ip_tables built in", withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{
			legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin + "kernel/net/ipv4/netfilter/ip_tables.ko\n",
		}), legacyNATTestRelease, legacyNATAvailable},
		{"ip_tables absent", legacyNATUnloadableHost, legacyNATTestRelease, legacyNATUnloadable},
		// A built-in ip_tables cannot be ruled out without modules.builtin.
		{"no builtin list, nat shipped", map[string]string{
			legacyNATTestModules + "modules.dep": legacyNATTestDep,
		}, legacyNATTestRelease, legacyNATUnknown},
		{"ip_tables absent, uncompressed modules", map[string]string{
			legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
			legacyNATTestModules + "modules.dep":     "kernel/net/ipv4/netfilter/iptable_nat.ko: kernel/net/netfilter/nf_nat.ko\n",
		}, legacyNATTestRelease, legacyNATUnloadable},
		{"module loading disabled", withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{
			"proc/modules":                     legacyNATTestNFTModules + "ip_tables 36864 1 iptable_filter, Live 0x0\n",
			"proc/sys/kernel/modules_disabled": "1\n",
		}), legacyNATTestRelease, legacyNATUnloadable},
		// Similar names never count as either module.
		{"similar names", withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{
			"proc/modules":                           "iptable_natural 12288 0 - Live 0x0\nip_tables_extra 12288 0 - Live 0x0\n",
			legacyNATTestModules + "modules.builtin": "kernel/net/ipv4/netfilter/iptable_nat_extra.ko\nkernel/net/ipv4/netfilter/xip_tables.ko\n",
		}), legacyNATTestRelease, legacyNATUnloadable},
		{"kernel ships no nat module", map[string]string{
			"proc/net/ip_tables_names":               "filter\n",
			legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
			legacyNATTestModules + "modules.dep":     "kernel/net/ipv4/netfilter/ip_tables.ko.zst: kernel/net/netfilter/x_tables.ko.zst\nkernel/net/ipv4/netfilter/xiptable_nat.ko.zst:\n",
		}, legacyNATTestRelease, legacyNATMissing},
		// Hosts such as NixOS keep modules elsewhere; never fail on them.
		{"no module index", map[string]string{"proc/modules": legacyNATTestNFTModules}, legacyNATTestRelease, legacyNATUnknown},
		{"no builtin list", map[string]string{
			legacyNATTestModules + "modules.dep": "kernel/net/ipv4/netfilter/ip_tables.ko.zst:\n",
		}, legacyNATTestRelease, legacyNATUnknown},
		{"unusable release", map[string]string{"lib/modules/x/modules.dep": legacyNATTestDep}, "../x", legacyNATUnknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := legacyNATTableState(legacyNATTestFiles(test.files), test.release); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}

// legacyNATHost replaces the host root and operating system for one test.
func legacyNATHost(t *testing.T, hostOS string, fsys fs.FS) {
	t.Helper()
	previousFS, previousOS := hostFilesystem, developmentHostOS
	hostFilesystem, developmentHostOS = fsys, hostOS
	t.Cleanup(func() { hostFilesystem, developmentHostOS = previousFS, previousOS })
}

func TestCheckLegacyNATTable(t *testing.T) {
	dockerHost := `"info --format {{.KernelVersion}} {{.Name}}") echo '` + legacyNATTestRelease + ` ` + legacyNATTestHostname + `' ;;
`
	podmanHost := `"info --format {{.Host.Kernel}} {{.Host.Hostname}}") echo '` + legacyNATTestRelease + ` ` + legacyNATTestHostname + `' ;;
`
	for _, test := range []struct {
		name, hostOS, engine, script string
		files                        map[string]string
		wantError, wantWarning       []string
		wantHint                     bool
	}{
		{
			name: "ip_tables absent fails fast", hostOS: "linux", engine: "docker", script: dockerHost, files: legacyNATUnloadableHost,
			wantError: []string{"has not loaded the legacy iptables modules (ip_tables, iptable_nat)", "IPTABLES_MODE=legacy", "sudo modprobe --all iptable_nat iptable_filter iptable_mangle br_netfilter", `"Local K3s cannot load the legacy iptables nat table"`, "troubleshooting.md"},
		},
		{
			name: "Podman on this host", hostOS: "linux", engine: "podman", script: podmanHost, files: legacyNATUnloadableHost,
			wantError: []string{"sudo modprobe --all iptable_nat"},
		},
		{
			name: "kernel without the module fails fast", hostOS: "linux", engine: "docker", script: dockerHost,
			files: map[string]string{
				legacyNATTestModules + "modules.builtin": legacyNATTestBuiltin,
				legacyNATTestModules + "modules.dep":     "",
			},
			wantError: []string{"kernel " + legacyNATTestRelease + " provides no legacy iptables nat table", "IPTABLES_MODE=legacy", "troubleshooting.md"},
		},
		{name: "nat loads on demand", hostOS: "linux", engine: "docker", script: dockerHost, files: withLegacyNATFiles(legacyNATUnloadableHost, map[string]string{"sys/module/ip_tables/refcnt": "1\n"})},
		{
			name: "undecidable host only warns", hostOS: "linux", engine: "docker", script: dockerHost,
			wantWarning: []string{"Warning: could not confirm", "sudo modprobe --all iptable_nat", "troubleshooting.md"},
			wantHint:    true,
		},
		// Docker Desktop and Podman machines run the node on another kernel;
		// an equal release on another host is not this kernel either.
		{name: "engine in a VM", hostOS: "linux", engine: "docker", script: `"info --format {{.KernelVersion}} {{.Name}}") echo '6.10.14-linuxkit docker-desktop' ;;
`, files: legacyNATUnloadableHost},
		{name: "same release on another host", hostOS: "linux", engine: "podman", script: `"info --format {{.Host.Kernel}} {{.Host.Hostname}}") echo '` + legacyNATTestRelease + ` localhost.localdomain' ;;
`, files: legacyNATUnloadableHost},
		{name: "engine identity unavailable", hostOS: "linux", engine: "docker", script: `"info --format {{.KernelVersion}} {{.Name}}") exit 1 ;;
`, files: legacyNATUnloadableHost},
		{name: "macOS host", hostOS: "darwin", engine: "docker", script: dockerHost, files: legacyNATUnloadableHost},
	} {
		t.Run(test.name, func(t *testing.T) {
			legacyNATHost(t, test.hostOS, legacyNATTestFiles(test.files))
			fakeEngine(t, test.engine, test.script)
			var warnings bytes.Buffer
			r := &runner{engine: test.engine, env: map[string]string{}, opts: Options{Err: &warnings}}
			err := r.checkLegacyNATTable(context.Background())
			if len(test.wantError) == 0 && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(test.wantError) != 0 && err == nil {
				t.Fatal("expected an error")
			}
			for _, want := range test.wantError {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error %q does not contain %q", err, want)
				}
			}
			if len(test.wantWarning) == 0 && warnings.Len() != 0 {
				t.Fatalf("unexpected warning: %q", warnings.String())
			}
			for _, want := range test.wantWarning {
				if !strings.Contains(warnings.String(), want) {
					t.Fatalf("warning %q does not contain %q", warnings.String(), want)
				}
			}
			if r.legacyNATUnconfirmed != test.wantHint {
				t.Fatalf("preflight unconfirmed: %v, want: %v", r.legacyNATUnconfirmed, test.wantHint)
			}
		})
	}
}

// The Kubernetes-only profile checks the host before it records state or
// asks k3d for anything, so the reported host fails at once.
func TestK3dStartupChecksLegacyNATTableBeforeClusterCreation(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	for _, key := range []string{"DOCKER_CONTEXT", "OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "OCC_DEVELOPMENT_REPOSITORY_IMAGE"} {
		t.Setenv(key, "")
	}
	for key, value := range map[string]string{
		"OCC_DEVELOPMENT_STATE_DIRECTORY":     state,
		"OCC_DEVELOPMENT_KUBERNETES_CLUSTER":  "occ-dev-nat",
		"OCC_DEVELOPMENT_CONTAINER_ENGINE":    "docker",
		"DOCKER_HOST":                         "unix:///fixture/docker.sock",
		"OPENCLAW_DEV_PORT":                   "3000",
		"OCC_DEVELOPMENT_KUBERNETES_API_PORT": "6443",
		"OCC_DEVELOPMENT_BROWSER_PORT":        "8443",
	} {
		t.Setenv(key, value)
	}
	legacyNATHost(t, "linux", legacyNATTestFiles(legacyNATUnloadableHost))
	// PATH contains only fixtures, so no real tool can run.
	t.Setenv("PATH", t.TempDir())
	commands := fakeProfileCommands(t, map[string]string{
		"docker": `"version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker"}}' ;;
"info") ;;
"info --format {{.KernelVersion}} {{.Name}}") echo '` + legacyNATTestRelease + ` ` + legacyNATTestHostname + `' ;;`,
		"k3d":     "",
		"kubectl": "",
		"helm":    "",
		"node":    "",
		"git":     "",
	})
	err := upK3d(context.Background(), Options{Repository: root}, "none")
	if err == nil || !strings.Contains(err.Error(), "has not loaded the legacy iptables modules") {
		t.Fatalf("expected the legacy iptables error, got %v", err)
	}
	for _, call := range commands() {
		if strings.HasPrefix(call, "k3d ") {
			t.Fatalf("k3d ran before the preflight failed: %q", call)
		}
	}
	if _, err := os.Stat(filepath.Join(state, "state.json")); !os.IsNotExist(err) {
		t.Fatalf("startup recorded state before the preflight: %v", err)
	}
}

// The rollback removes the node log, so a k3d failure after an unconfirmed
// preflight names the nat table and its remedy.
func TestK3dCreateFailureNamesAnUnconfirmedLegacyNATTable(t *testing.T) {
	fakeK3dCreate(t, k3dRollback+"\nexit 1")
	r := &runner{opts: Options{Out: io.Discard, Err: io.Discard}, env: map[string]string{}}
	err := r.createK3dCluster(context.Background(), "cluster", "create", "occ-dev-test")
	if err == nil || strings.Contains(err.Error(), "iptable_nat") {
		t.Fatalf("a confirmed host got the nat hint: %v", err)
	}
	r.legacyNATUnconfirmed = true
	err = r.createK3dCluster(context.Background(), "cluster", "create", "occ-dev-test")
	var exitErr *exec.ExitError
	if err == nil || !strings.HasPrefix(err.Error(), "k3d failed: exit status 1\n") || !strings.Contains(err.Error(), "could not confirm that the host loaded iptable_nat") || !strings.Contains(err.Error(), "sudo modprobe --all iptable_nat") || !errors.As(err, &exitErr) {
		t.Fatalf("expected the nat hint on the k3d failure, got %v", err)
	}
}
