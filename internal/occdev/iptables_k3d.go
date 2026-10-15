package occdev

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strings"
)

// Both local k3d profiles start the node with IPTABLES_MODE=legacy, so
// kube-proxy needs the host kernel's legacy iptables nat table. Once ip_tables
// is loaded (or built in), the kernel loads iptable_nat on demand when the
// node first asks for the nat table. The node cannot load ip_tables itself:
// without it there is no legacy iptables socket option for the kernel to
// answer, and the node's own modprobe has no host modules. kube-proxy then
// exits, K3s shuts down, and k3d reports only a failure when its startup
// timeout expires. The preflight below fails fast in that state and for a
// kernel without a legacy nat table, and only warns when it cannot decide.

// hostFilesystem is the host root, replaced in tests.
var hostFilesystem fs.FS = os.DirFS("/")

const legacyNATModule = "iptable_nat"

const legacyIPTablesModule = "ip_tables"

const legacyNATRemedy = "sudo modprobe --all iptable_nat iptable_filter iptable_mangle br_netfilter"

const legacyNATTroubleshooting = `See "Local K3s cannot load the legacy iptables nat table" in docs/guides/operate/troubleshooting.md.`

type legacyNATState int

const (
	// legacyNATAvailable: the nat table is loaded, built in, or loadable on
	// demand because ip_tables is present.
	legacyNATAvailable legacyNATState = iota
	// legacyNATUnloadable: the kernel ships the modules, but the node cannot
	// load them (ip_tables is absent, or module loading is disabled).
	legacyNATUnloadable
	// legacyNATMissing: the kernel ships no legacy nat table at all.
	legacyNATMissing
	// legacyNATUnknown: the host does not expose enough to decide.
	legacyNATUnknown
)

// legacyNATTableState reads kernel state an ordinary user can see. A loaded
// module appears in /sys/module and /proc/modules; a built-in one appears in
// neither /proc/modules nor, without parameters, /sys/module, so
// modules.builtin decides that case. /proc/net/ip_tables_names exists only
// while ip_tables is present; it is readable only by root, so only its
// existence is relied on.
func legacyNATTableState(fsys fs.FS, release string) legacyNATState {
	modules, _ := fs.ReadFile(fsys, "proc/modules")
	loaded := func(module string) bool {
		if _, err := fs.Stat(fsys, "sys/module/"+module); err == nil {
			return true
		}
		return anyLine(modules, func(line string) bool {
			name, _, _ := strings.Cut(line, " ")
			return name == module
		})
	}
	if loaded(legacyNATModule) {
		return legacyNATAvailable
	}
	if tables, err := fs.ReadFile(fsys, "proc/net/ip_tables_names"); err == nil && anyLine(tables, func(line string) bool {
		return strings.TrimSpace(line) == "nat"
	}) {
		return legacyNATAvailable
	}
	if release == "" || strings.Contains(release, "/") || !fs.ValidPath(release) {
		return legacyNATUnknown
	}
	directory := path.Join("lib/modules", release)
	builtin, builtinErr := fs.ReadFile(fsys, path.Join(directory, "modules.builtin"))
	if builtinErr == nil && listsKernelModule(builtin, legacyNATModule) {
		return legacyNATAvailable
	}
	dependencies, err := fs.ReadFile(fsys, path.Join(directory, "modules.dep"))
	if err != nil {
		return legacyNATUnknown
	}
	if !listsKernelModule(dependencies, legacyNATModule) {
		if builtinErr != nil {
			return legacyNATUnknown
		}
		return legacyNATMissing
	}
	if disabled, err := fs.ReadFile(fsys, "proc/sys/kernel/modules_disabled"); err == nil && strings.TrimSpace(string(disabled)) == "1" {
		return legacyNATUnloadable
	}
	if _, err := fs.Stat(fsys, "proc/net/ip_tables_names"); err == nil || loaded(legacyIPTablesModule) || (builtinErr == nil && listsKernelModule(builtin, legacyIPTablesModule)) {
		return legacyNATAvailable
	}
	// Without modules.builtin, a built-in ip_tables cannot be ruled out.
	if builtinErr != nil {
		return legacyNATUnknown
	}
	return legacyNATUnloadable
}

// listsKernelModule matches the first path of each modules.builtin or
// modules.dep line, such as kernel/net/ipv4/netfilter/iptable_nat.ko.zst:.
func listsKernelModule(data []byte, module string) bool {
	return anyLine(data, func(line string) bool {
		file, _, _ := strings.Cut(line, ":")
		base := path.Base(strings.TrimSpace(file))
		return base == module+".ko" || strings.HasPrefix(base, module+".ko.")
	})
}

func anyLine(data []byte, match func(string) bool) bool {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		if match(scanner.Text()) {
			return true
		}
	}
	return false
}

// checkLegacyNATTable runs before k3d creates the node. Host files describe
// the node's kernel only when the engine runs on this kernel, so the check
// applies only on Linux and only when the engine reports this host's kernel
// release and hostname; Docker Desktop, Podman machines, remote engines, and
// engines seen from inside a container are skipped.
func (r *runner) checkLegacyNATTable(ctx context.Context) error {
	if developmentHostOS != "linux" {
		return nil
	}
	release := hostKernelValue("osrelease")
	hostname := hostKernelValue("hostname")
	if release == "" || hostname == "" {
		return nil
	}
	format := "{{.KernelVersion}} {{.Name}}"
	if r.engine == "podman" {
		format = "{{.Host.Kernel}} {{.Host.Hostname}}"
	}
	engineHost, err := r.output(ctx, r.engine, "info", "--format", format)
	if err != nil || string(engineHost) != release+" "+hostname {
		return nil
	}
	switch legacyNATTableState(hostFilesystem, release) {
	case legacyNATUnloadable:
		return fmt.Errorf("the host kernel has not loaded the legacy iptables modules (%s, %s) that the local k3d node needs because it runs K3s with IPTABLES_MODE=legacy. The node cannot load them itself, so cluster creation would stall until its startup timeout. Load the modules on the host, then start again:\n  %s\n%s", legacyIPTablesModule, legacyNATModule, legacyNATRemedy, legacyNATTroubleshooting)
	case legacyNATMissing:
		return fmt.Errorf("the host kernel %s provides no legacy iptables nat table (%s), which the local k3d node needs because it runs K3s with IPTABLES_MODE=legacy. Use a kernel that ships the module. %s", release, legacyNATModule, legacyNATTroubleshooting)
	case legacyNATUnknown:
		r.legacyNATUnconfirmed = true
		fmt.Fprintf(r.opts.Err, "Warning: could not confirm that the host kernel provides the legacy iptables nat table (%s) that the k3d node uses; continuing. If cluster creation stalls, run `%s` on the host. %s\n", legacyNATModule, legacyNATRemedy, legacyNATTroubleshooting)
	}
	return nil
}

func hostKernelValue(name string) string {
	data, err := fs.ReadFile(hostFilesystem, "proc/sys/kernel/"+name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// legacyNATFailureHint is the k3d failure hint for the nat table. The
// rollback removes the node log that would show kube-proxy's error, so the
// hint is conditional.
const legacyNATFailureHint = "If the node could not initialize the legacy iptables nat table (" + legacyNATModule + "), run `" + legacyNATRemedy + "` on the host and start again. " + legacyNATTroubleshooting
