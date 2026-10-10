package occdev

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Output of the k3s image's BusyBox nslookup when the node resolver refuses.
const busyboxRefused = ";; connection timed out; no servers could be reached\n\nnslookup: write to '172.18.0.1': Connection refused\n"

func TestClassifyDevelopmentNodeDNS(t *testing.T) {
	failed := errors.New("exit status 1")
	for _, test := range []struct {
		name   string
		output string
		err    error
		want   developmentNodeDNSOutcome
	}{
		{"resolved", "Name:\tregistry-1.docker.io\nAddress: 192.0.2.10\n", nil, nodeDNSResolved},
		{"refused", busyboxRefused, failed, nodeDNSRefused},
		{"refused, BIND", ";; communications error to 172.18.0.1#53: connection refused\n;; no servers could be reached\n", failed, nodeDNSRefused},
		// A network may drop public DNS on purpose; only a refusal stops startup.
		{"timed out", ";; connection timed out; no servers could be reached\n", failed, nodeDNSInconclusive},
		// A resolver that answers, even with an error, is not the gateway failure.
		{"no such name", "** server can't find registry-1.docker.io: NXDOMAIN\n", failed, nodeDNSInconclusive},
		{"no nslookup in a custom node image", `exec: "nslookup": executable file not found in $PATH`, failed, nodeDNSInconclusive},
		{"engine unavailable", "Error: unable to connect to Podman socket: connection refused", failed, nodeDNSInconclusive},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := classifyDevelopmentNodeDNS([]byte(test.output), test.err); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}

func TestDevelopmentNodeDNSErrorNamesTheResolverSetting(t *testing.T) {
	err := developmentNodeDNSError("k3d-occ-dev-test-server-0", "", "10.0.0.2")
	for _, want := range []string{"k3d-occ-dev-test-server-0", "registry-1.docker.io", "refused the query", "iptables-nft", "OCC_DEVELOPMENT_K3D_DNS_RESOLVER=10.0.0.2"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
	if err := developmentNodeDNSError("node", "", ""); !strings.Contains(err.Error(), "Set OCC_DEVELOPMENT_K3D_DNS_RESOLVER to an IPv4 DNS server") || strings.Contains(err.Error(), "for example OCC_") {
		t.Fatalf("unexpected error without an upstream hint: %q", err)
	}
	// An explicit resolver that does not answer is named as the cause.
	if err := developmentNodeDNSError("node", "192.0.2.53", "10.0.0.2"); !strings.Contains(err.Error(), "OCC_DEVELOPMENT_K3D_DNS_RESOLVER=192.0.2.53 refused the query") {
		t.Fatalf("unexpected error for a configured resolver: %q", err)
	}
}

func TestHostUpstreamResolverSkipsLoopbackStubs(t *testing.T) {
	files := map[string]string{
		"/run/systemd/resolve/resolv.conf": "# upstream\nnameserver fe80::1\nnameserver 168.63.129.16\nnameserver 10.0.0.3\n",
		"/etc/resolv.conf":                 "nameserver 127.0.0.53\n",
	}
	read := func(path string) ([]byte, error) {
		if data, ok := files[path]; ok {
			return []byte(data), nil
		}
		return nil, os.ErrNotExist
	}
	if got := hostUpstreamResolver(read); got != "168.63.129.16" {
		t.Fatalf("got %q", got)
	}
	delete(files, "/run/systemd/resolve/resolv.conf")
	if got := hostUpstreamResolver(read); got != "" {
		t.Fatalf("a loopback stub was suggested: %q", got)
	}
	files["/etc/resolv.conf"] = "search example.test\nnameserver 192.168.1.1 \n"
	if got := hostUpstreamResolver(read); got != "192.168.1.1" {
		t.Fatalf("got %q", got)
	}
}

func fastNodeDNSRetries(t *testing.T) {
	t.Helper()
	previous := developmentNodeDNSRetryDelay
	developmentNodeDNSRetryDelay = time.Millisecond
	t.Cleanup(func() { developmentNodeDNSRetryDelay = previous })
}

func TestCheckDevelopmentNodeDNS(t *testing.T) {
	const lookup = `"exec k3d-occ-dev-test-server-0 nslookup registry-1.docker.io")`
	state := &developmentState{Cluster: "occ-dev-test"}

	t.Run("resolved", func(t *testing.T) {
		fakeEngine(t, "docker", lookup+` echo 'Name: registry-1.docker.io' ;;
`)
		var warnings bytes.Buffer
		r := &runner{engine: "docker", env: map[string]string{}, opts: Options{Err: &warnings}}
		if err := r.checkDevelopmentNodeDNS(context.Background(), state); err != nil {
			t.Fatal(err)
		}
		if warnings.Len() != 0 {
			t.Fatalf("unexpected warning: %q", warnings.String())
		}
	})

	t.Run("refused after retries", func(t *testing.T) {
		fastNodeDNSRetries(t)
		count := filepath.Join(t.TempDir(), "attempts")
		fakeEngine(t, "docker", lookup+` echo x >> `+count+`; printf '%s' "`+busyboxRefused+`"; exit 1 ;;
`)
		r := &runner{engine: "docker", env: map[string]string{"OCC_DEVELOPMENT_K3D_DNS_RESOLVER": ""}}
		err := r.checkDevelopmentNodeDNS(context.Background(), state)
		if err == nil || !strings.Contains(err.Error(), "Set OCC_DEVELOPMENT_K3D_DNS_RESOLVER") {
			t.Fatalf("expected the resolver error, got %v", err)
		}
		data, _ := os.ReadFile(count)
		if attempts := strings.Count(string(data), "x"); attempts != developmentNodeDNSAttempts {
			t.Fatalf("got %d lookups, want %d", attempts, developmentNodeDNSAttempts)
		}
	})

	t.Run("answers on retry", func(t *testing.T) {
		fastNodeDNSRetries(t)
		marker := filepath.Join(t.TempDir(), "seen")
		fakeEngine(t, "podman", lookup+` if [ -e `+marker+` ]; then echo 'Name: registry-1.docker.io'; else touch `+marker+`; printf '%s' "`+busyboxRefused+`"; exit 1; fi ;;
`)
		r := &runner{engine: "podman", env: map[string]string{}}
		if err := r.checkDevelopmentNodeDNS(context.Background(), state); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("inconclusive only warns", func(t *testing.T) {
		fakeEngine(t, "podman", lookup+` echo "** server can't find registry-1.docker.io: NXDOMAIN"; exit 1 ;;
`)
		var warnings bytes.Buffer
		r := &runner{engine: "podman", env: map[string]string{}, opts: Options{Err: &warnings}}
		if err := r.checkDevelopmentNodeDNS(context.Background(), state); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(warnings.String(), "could not confirm") {
			t.Fatalf("expected a warning, got %q", warnings.String())
		}
	})
}

// hostResolverFiles replaces the host resolver files and operating system for one test.
func hostResolverFiles(t *testing.T, hostOS string, files map[string]string) {
	t.Helper()
	previousRead, previousOS := readHostResolverFile, developmentHostOS
	readHostResolverFile = func(path string) ([]byte, error) {
		if data, ok := files[path]; ok {
			return []byte(data), nil
		}
		return nil, os.ErrNotExist
	}
	developmentHostOS = hostOS
	t.Cleanup(func() { readHostResolverFile, developmentHostOS = previousRead, previousOS })
}

// prepareResolver returns the runner, its cluster arguments, the node resolv.conf it wrote (if any), and stdout.
func prepareResolver(t *testing.T, engine string, env map[string]string) (*runner, []string, string, string, error) {
	t.Helper()
	state := &developmentState{directory: t.TempDir()}
	var out bytes.Buffer
	r := &runner{engine: engine, env: env, opts: Options{Out: &out, Err: io.Discard}}
	args, err := r.prepareDevelopmentResolver(context.Background(), state, openShellK3sImage)
	resolvConf, _ := os.ReadFile(filepath.Join(state.directory, "node-resolv.conf"))
	return r, args, string(resolvConf), out.String(), err
}

func TestPrepareDevelopmentResolverDefaultsToHostUpstreamOnLinuxDocker(t *testing.T) {
	systemdResolved := map[string]string{
		"/run/systemd/resolve/resolv.conf": "nameserver 168.63.129.16\n",
		"/etc/resolv.conf":                 "nameserver 127.0.0.53\n",
	}

	t.Run("Linux Docker uses the systemd-resolved upstream, not the stub", func(t *testing.T) {
		hostResolverFiles(t, "linux", systemdResolved)
		r, args, resolvConf, out, err := prepareResolver(t, "docker", map[string]string{})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "upstream DNS resolver 168.63.129.16") || !strings.Contains(out, "to k3d to keep k3d's default") {
			t.Fatalf("startup did not say which resolver it chose: %q", out)
		}
		if len(args) != 2 || args[0] != "--volume" || !strings.HasSuffix(args[1], ":/etc/resolv.conf:ro@server:0") {
			t.Fatalf("unexpected cluster arguments: %q", args)
		}
		if resolvConf != "nameserver 168.63.129.16\n" {
			t.Fatalf("unexpected node resolv.conf: %q", resolvConf)
		}
		if r.env["K3D_FIX_DNS"] != "false" || r.automaticNodeResolver != "168.63.129.16" {
			t.Fatalf("automatic resolver not recorded: %q %q", r.env["K3D_FIX_DNS"], r.automaticNodeResolver)
		}
		if _, set := r.env["OCC_DEVELOPMENT_K3D_DNS_RESOLVER"]; set {
			t.Fatal("the automatic resolver must not look like an explicit setting")
		}
	})

	t.Run("an explicit resolver wins", func(t *testing.T) {
		hostResolverFiles(t, "linux", systemdResolved)
		r, _, resolvConf, _, err := prepareResolver(t, "docker", map[string]string{"OCC_DEVELOPMENT_K3D_DNS_RESOLVER": "192.0.2.53"})
		if err != nil {
			t.Fatal(err)
		}
		if resolvConf != "nameserver 192.0.2.53\n" || r.automaticNodeResolver != "" {
			t.Fatalf("explicit resolver not used: %q %q", resolvConf, r.automaticNodeResolver)
		}
	})

	t.Run("k3d keeps k3d's default resolver", func(t *testing.T) {
		hostResolverFiles(t, "linux", systemdResolved)
		r, args, _, _, err := prepareResolver(t, "docker", map[string]string{"OCC_DEVELOPMENT_K3D_DNS_RESOLVER": "k3d"})
		if err != nil || len(args) != 0 || r.env["K3D_FIX_DNS"] != "" || r.automaticNodeResolver != "" {
			t.Fatalf("k3d default not kept: %v %q %+v", err, args, r.env)
		}
	})

	for _, test := range []struct {
		name, hostOS, engine string
		files                map[string]string
	}{
		{"Podman keeps k3d's default", "linux", "podman", systemdResolved},
		{"macOS Podman keeps k3d's default", "darwin", "podman", systemdResolved},
		{"only a loopback stub keeps k3d's default", "linux", "docker", map[string]string{"/etc/resolv.conf": "nameserver 127.0.0.53\n"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			hostResolverFiles(t, test.hostOS, test.files)
			r, args, _, _, err := prepareResolver(t, test.engine, map[string]string{})
			if err != nil || len(args) != 0 || r.env["K3D_FIX_DNS"] != "" || r.automaticNodeResolver != "" {
				t.Fatalf("unexpected resolver change: %v %q %+v", err, args, r.env)
			}
		})
	}

	t.Run("invalid explicit resolver", func(t *testing.T) {
		hostResolverFiles(t, "linux", systemdResolved)
		if _, _, _, _, err := prepareResolver(t, "docker", map[string]string{"OCC_DEVELOPMENT_K3D_DNS_RESOLVER": "127.0.0.53"}); err == nil {
			t.Fatal("a loopback resolver was accepted")
		}
	})
}

// What Docker Desktop writes into a container on its default bridge network.
const dockerDesktopBridgeResolvConf = `# Generated by Docker Engine.
# This file can be edited; Docker Engine will not make further changes once it
# has been modified.

nameserver 192.168.65.7

# Based on host file: '/etc/resolv.conf' (legacy)
# Overrides: []
`

func TestPrepareDevelopmentResolverUsesDockerDesktopBridgeResolverOnMacOS(t *testing.T) {
	// On Docker Desktop, k3d's default node resolver (the host gateway) drops
	// queries and every image pull times out. The Mac's own resolver, here a VPN
	// address, may be reachable only from the host, so it must not be used.
	macResolver := map[string]string{"/etc/resolv.conf": "nameserver 198.51.100.53\n"}
	const composeNodeImage = "docker.io/rancher/k3s:v1.35.8-k3s1"
	dockerDesktop := `"info --format {{.OperatingSystem}}") echo 'Docker Desktop' ;;
`
	bridgeProbe := func(image string) string {
		return `"run --rm --network bridge --entrypoint cat ` + image + ` /etc/resolv.conf")`
	}
	answersProbe := func(image string) string {
		return bridgeProbe(image) + ` printf '%s' "` + dockerDesktopBridgeResolvConf + `" ;;
`
	}
	// prepare selects the resolver for a profile whose k3d node image is
	// nodeImage and returns the runner, its cluster arguments, the node
	// resolv.conf it wrote (if any), stdout, and stderr.
	prepare := func(t *testing.T, nodeImage string, env map[string]string) (*runner, []string, string, string, string) {
		t.Helper()
		state := &developmentState{directory: t.TempDir()}
		var out, warnings bytes.Buffer
		r := &runner{engine: "docker", env: env, opts: Options{Out: &out, Err: &warnings}}
		args, err := r.prepareDevelopmentResolver(context.Background(), state, nodeImage)
		if err != nil {
			t.Fatal(err)
		}
		resolvConf, _ := os.ReadFile(filepath.Join(state.directory, "node-resolv.conf"))
		return r, args, string(resolvConf), out.String(), warnings.String()
	}
	keptK3dDefault := func(t *testing.T, r *runner, args []string) {
		t.Helper()
		if len(args) != 0 || r.env["K3D_FIX_DNS"] != "" || r.automaticNodeResolver != "" {
			t.Fatalf("unexpected resolver change: %q %+v", args, r.env)
		}
	}

	t.Run("Docker Desktop uses the default-bridge resolver", func(t *testing.T) {
		hostResolverFiles(t, "darwin", macResolver)
		fakeEngine(t, "docker", dockerDesktop+answersProbe(openShellK3sImage))
		r, args, resolvConf, out, warnings := prepare(t, openShellK3sImage, map[string]string{})
		if !strings.Contains(out, "Docker Desktop's default-bridge DNS resolver 192.168.65.7") {
			t.Fatalf("startup did not say which resolver it chose: %q", out)
		}
		if len(args) != 2 || args[0] != "--volume" || !strings.HasSuffix(args[1], ":/etc/resolv.conf:ro@server:0") {
			t.Fatalf("unexpected cluster arguments: %q", args)
		}
		if resolvConf != "nameserver 192.168.65.7\n" {
			t.Fatalf("unexpected node resolv.conf: %q", resolvConf)
		}
		if r.env["K3D_FIX_DNS"] != "false" || r.automaticNodeResolver != "192.168.65.7" || warnings != "" {
			t.Fatalf("automatic resolver not recorded: %q %q %q", r.env["K3D_FIX_DNS"], r.automaticNodeResolver, warnings)
		}
	})

	// The probe must pull nothing a fresh Mac would not pull for the cluster
	// anyway. The fake engine answers only the expected image, so a probe of
	// any other image fails and keeps k3d's default.
	for _, test := range []struct {
		name, nodeImage, probeImage string
	}{
		{"the probe runs the Compose profile's node image", composeNodeImage, composeNodeImage},
		{"a k3d channel, which Docker cannot run, probes with the pinned image", "+v1.35", openShellK3sImage},
	} {
		t.Run(test.name, func(t *testing.T) {
			hostResolverFiles(t, "darwin", macResolver)
			fakeEngine(t, "docker", dockerDesktop+answersProbe(test.probeImage))
			r, _, _, out, warnings := prepare(t, test.nodeImage, map[string]string{})
			if r.automaticNodeResolver != "192.168.65.7" || warnings != "" {
				t.Fatalf("probe did not use %s: %q %q", test.probeImage, r.automaticNodeResolver, warnings)
			}
			if !strings.Contains(out, "throwaway "+test.probeImage+" container") {
				t.Fatalf("startup did not name the probe image: %q", out)
			}
		})
	}

	// Only Docker Desktop's gateway is known to drop node DNS. Other macOS
	// engines keep k3d's default without running a probe container, which the
	// fake engine would refuse.
	for _, system := range []string{"OrbStack", "Ubuntu 24.04.3 LTS"} {
		t.Run(system+" keeps k3d's default", func(t *testing.T) {
			hostResolverFiles(t, "darwin", macResolver)
			fakeEngine(t, "docker", `"info --format {{.OperatingSystem}}") echo '`+system+`' ;;
`)
			r, args, _, out, warnings := prepare(t, openShellK3sImage, map[string]string{})
			keptK3dDefault(t, r, args)
			if out != "" || warnings != "" {
				t.Fatalf("unexpected output: %q %q", out, warnings)
			}
		})
	}

	t.Run("an explicit resolver or k3d skips the probe", func(t *testing.T) {
		hostResolverFiles(t, "darwin", macResolver)
		fakeEngine(t, "docker", "")
		r, args, _, out, warnings := prepare(t, openShellK3sImage, map[string]string{"OCC_DEVELOPMENT_K3D_DNS_RESOLVER": "k3d"})
		keptK3dDefault(t, r, args)
		_, _, resolvConf, explicitOut, explicitWarnings := prepare(t, openShellK3sImage, map[string]string{"OCC_DEVELOPMENT_K3D_DNS_RESOLVER": "192.0.2.53"})
		if resolvConf != "nameserver 192.0.2.53\n" || out+warnings+explicitOut+explicitWarnings != "" {
			t.Fatalf("explicit resolver not kept: %q %q %q", resolvConf, out+explicitOut, warnings+explicitWarnings)
		}
	})

	t.Run("a probe container that cannot run keeps k3d's default", func(t *testing.T) {
		hostResolverFiles(t, "darwin", macResolver)
		fakeEngine(t, "docker", dockerDesktop+bridgeProbe(openShellK3sImage)+` echo 'Cannot connect to the Docker daemon' >&2; exit 125 ;;
`)
		r, args, _, _, warnings := prepare(t, openShellK3sImage, map[string]string{})
		keptK3dDefault(t, r, args)
		if !strings.Contains(warnings, "keeping k3d's default") || strings.Contains(warnings, "Cannot connect") {
			t.Fatalf("unexpected warning: %q", warnings)
		}
	})

	t.Run("a probe that hangs times out and keeps k3d's default", func(t *testing.T) {
		// A wedged engine or a stalled first pull must not hold startup
		// before cluster creation.
		previous := dockerDesktopProbeTimeout
		dockerDesktopProbeTimeout = 200 * time.Millisecond
		t.Cleanup(func() { dockerDesktopProbeTimeout = previous })
		hostResolverFiles(t, "darwin", macResolver)
		fakeEngine(t, "docker", dockerDesktop+bridgeProbe(openShellK3sImage)+` exec /bin/sleep 30 ;;
`)
		started := time.Now()
		r, args, _, _, warnings := prepare(t, openShellK3sImage, map[string]string{})
		if elapsed := time.Since(started); elapsed > 10*time.Second {
			t.Fatalf("probe was not bounded: %s", elapsed)
		}
		keptK3dDefault(t, r, args)
		if !strings.Contains(warnings, "timed out after 200ms") || !strings.Contains(warnings, "OCC_DEVELOPMENT_K3D_DNS_RESOLVER") {
			t.Fatalf("timeout not reported: %q", warnings)
		}
	})

	// An empty, IPv6-only, or loopback resolv.conf is a failed probe. Returning
	// "" with a nil error would keep k3d's default and skip the warning.
	for _, test := range []struct {
		name, resolvConf string
	}{
		{"IPv6 only", "nameserver 2001:db8::53"},
		{"loopback", "nameserver 127.0.0.11"},
		{"empty", "# empty"},
	} {
		t.Run(test.name+" nameserver warns and keeps k3d's default", func(t *testing.T) {
			hostResolverFiles(t, "darwin", macResolver)
			fakeEngine(t, "docker", dockerDesktop+bridgeProbe(openShellK3sImage)+` printf '%s\n' '`+test.resolvConf+`' ;;
`)
			r, args, _, _, warnings := prepare(t, openShellK3sImage, map[string]string{})
			keptK3dDefault(t, r, args)
			if !strings.Contains(warnings, "no usable IPv4 nameserver") || !strings.Contains(warnings, "keeping k3d's default") || !strings.Contains(warnings, "OCC_DEVELOPMENT_K3D_DNS_RESOLVER") {
				t.Fatalf("missing warning: %q", warnings)
			}
		})
	}
}

func TestCheckDevelopmentNodeDNSNamesTheAutomaticResolver(t *testing.T) {
	fastNodeDNSRetries(t)
	hostResolverFiles(t, "linux", map[string]string{})
	const lookup = `"exec k3d-occ-dev-test-server-0 nslookup registry-1.docker.io")`
	fakeEngine(t, "docker", lookup+` printf '%s' "`+busyboxRefused+`"; exit 1 ;;
`)
	r := &runner{engine: "docker", env: map[string]string{}, automaticNodeResolver: "10.0.0.3", automaticNodeResolverOrigin: "this host's upstream"}
	err := r.checkDevelopmentNodeDNS(context.Background(), &developmentState{Cluster: "occ-dev-test"})
	if err == nil {
		t.Fatal("expected the resolver error")
	}
	for _, want := range []string{"upstream resolver 10.0.0.3", "OCC_DEVELOPMENT_K3D_DNS_RESOLVER is unset", "or to k3d to keep k3d's default"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
	// With k3d's default kept explicitly, the error suggests the host upstream, not "k3d refused".
	hostResolverFiles(t, "linux", map[string]string{"/etc/resolv.conf": "nameserver 10.0.0.2\n"})
	r = &runner{engine: "docker", env: map[string]string{"OCC_DEVELOPMENT_K3D_DNS_RESOLVER": "k3d"}}
	err = r.checkDevelopmentNodeDNS(context.Background(), &developmentState{Cluster: "occ-dev-test"})
	if err == nil || strings.Contains(err.Error(), "=k3d refused") || !strings.Contains(err.Error(), "OCC_DEVELOPMENT_K3D_DNS_RESOLVER=10.0.0.2") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPrepareDevelopmentResolverPreservesNameserversWithTrailingComments(t *testing.T) {
	for _, source := range []string{"/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"} {
		for _, comment := range []string{"# upstream DNS", "; upstream DNS"} {
			t.Run(source+comment, func(t *testing.T) {
				files := map[string]string{source: "nameserver 10.0.0.2 " + comment + "\n"}
				if source != "/etc/resolv.conf" {
					files["/etc/resolv.conf"] = "nameserver 127.0.0.53\n"
				}
				hostResolverFiles(t, "linux", files)
				state := &developmentState{directory: t.TempDir()}
				r := &runner{engine: "docker", env: map[string]string{}, opts: Options{Out: io.Discard}}
				args, err := r.prepareDevelopmentResolver(context.Background(), state, openShellK3sImage)
				if err != nil {
					t.Fatal(err)
				}
				data, err := os.ReadFile(filepath.Join(state.directory, "node-resolv.conf"))
				if err != nil {
					t.Fatalf("host upstream was not selected: %v; args=%v", err, args)
				}
				if string(data) != "nameserver 10.0.0.2\n" {
					t.Fatalf("unexpected node resolver: %q", data)
				}
				if len(args) != 2 || r.env["K3D_FIX_DNS"] != "false" {
					t.Fatalf("explicit resolver mount missing: %v", args)
				}
			})
		}
	}
}
