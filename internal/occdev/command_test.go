package occdev

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakePodman puts a `podman` on PATH that answers the inventory commands
// endpoint resolution issues. Every other command fails, so a test only passes
// when resolution asks exactly what the real CLI supports.
func fakePodman(t *testing.T, script string) {
	t.Helper()
	directory := t.TempDir()
	executable := filepath.Join(directory, "podman")
	body := "#!/bin/sh\ncase \"$*\" in\n" + script +
		"*) echo \"unexpected: podman $*\" >&2; exit 99 ;;\nesac\n"
	if err := os.WriteFile(executable, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestPodmanEndpointResolvesTheForwardedSocketOfARootfulMachine(t *testing.T) {
	// Reproduces a rootful macOS machine. `podman info` reports the socket
	// inside the virtual machine, and the default connection is named for the
	// machine plus "-root", which `podman machine inspect` rejects. Startup
	// must still hand k3d the forwarded socket this host can reach; the guest
	// path would fail every later cluster and image call.
	fakePodman(t, `
"info --format json") echo '{"host":{"serviceIsRemote":true,"remoteSocket":{"path":"unix:///run/podman/podman.sock","exists":true}}}' ;;
"system connection list --format json") echo '[{"Name":"podman-machine-default","URI":"ssh://core@127.0.0.1:61712/run/user/501/podman/podman.sock","IsMachine":true,"Default":false},{"Name":"podman-machine-default-root","URI":"ssh://root@127.0.0.1:61712/run/podman/podman.sock","IsMachine":true,"Default":true}]' ;;
"machine inspect podman-machine-default-root") echo "Error: podman-machine-default-root: VM does not exist" >&2; exit 125 ;;
"machine inspect podman-machine-default") echo '[{"ConnectionInfo":{"PodmanSocket":{"Path":"/var/folders/x/T/podman/podman-machine-default-api.sock"}}}]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	endpoint, err := r.podmanEndpoint(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "unix:///var/folders/x/T/podman/podman-machine-default-api.sock" {
		t.Fatalf("resolved an unreachable endpoint: %q", endpoint)
	}
}

func TestPodmanEndpointUsesTheReportedSocketOfANativeService(t *testing.T) {
	// A native Linux service runs on this host, so its own socket is correct
	// and resolution must not consult a machine that does not exist.
	fakePodman(t, `
"info --format json") echo '{"host":{"serviceIsRemote":false,"remoteSocket":{"path":"unix:///run/user/1000/podman/podman.sock","exists":true}}}' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	endpoint, err := r.podmanEndpoint(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "unix:///run/user/1000/podman/podman.sock" {
		t.Fatalf("unexpected native endpoint: %q", endpoint)
	}
}

func TestPodmanEndpointFailsWhenNoMachineExposesAHostSocket(t *testing.T) {
	// A remote service whose machine cannot be inspected leaves no reachable
	// socket. Startup must fail here rather than create a cluster against an
	// endpoint that does not exist on this host.
	fakePodman(t, `
"info --format json") echo '{"host":{"serviceIsRemote":true,"remoteSocket":{"path":"unix:///run/podman/podman.sock"}}}' ;;
"system connection list --format json") echo '[]' ;;
"machine inspect podman-machine-default") echo "Error: VM does not exist" >&2; exit 125 ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	if _, err := r.podmanEndpoint(context.Background()); err == nil {
		t.Fatal("resolution accepted a machine with no host socket")
	}
}

func TestParsePodmanInfoSocketReportsRemoteService(t *testing.T) {
	// A machine-backed Podman service reports the socket inside its virtual
	// machine. Startup must recognize the remote service so it resolves the
	// forwarded host socket instead of using this unreachable guest path.
	socket, remote, err := parsePodmanInfoSocket([]byte(
		`{"host":{"serviceIsRemote":true,"remoteSocket":{"path":"unix:///run/user/501/podman/podman.sock","exists":true}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !remote {
		t.Fatal("machine-backed Podman was not reported as a remote service")
	}
	if socket != "unix:///run/user/501/podman/podman.sock" {
		t.Fatalf("unexpected reported socket: %q", socket)
	}

	// A native Linux service runs on this host, so its reported socket is the
	// one to use directly.
	socket, remote, err = parsePodmanInfoSocket([]byte(
		`{"host":{"serviceIsRemote":false,"remoteSocket":{"path":"unix:///run/user/1000/podman/podman.sock"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if remote {
		t.Fatal("native Podman was reported as a remote service")
	}
	if unixEndpoint(socket) != "unix:///run/user/1000/podman/podman.sock" {
		t.Fatalf("unexpected native endpoint: %q", unixEndpoint(socket))
	}
}

func TestParsePodmanMachineSocketSelectsTheForwardedHostSocket(t *testing.T) {
	// `podman machine inspect` records the only socket the host can reach.
	socket := parsePodmanMachineSocket([]byte(
		`[{"Name":"podman-machine-default","ConnectionInfo":{"PodmanSocket":{"Path":"/var/folders/x/T/podman/podman-machine-default-api.sock"}}}]`))
	if socket != "/var/folders/x/T/podman/podman-machine-default-api.sock" {
		t.Fatalf("unexpected machine socket: %q", socket)
	}
	// An absent machine or socket must not produce a partial endpoint.
	if socket := parsePodmanMachineSocket([]byte(`[]`)); socket != "" {
		t.Fatalf("empty inventory produced a socket: %q", socket)
	}
	if socket := parsePodmanMachineSocket([]byte(`[{"ConnectionInfo":{}}]`)); socket != "" {
		t.Fatalf("machine without a socket produced one: %q", socket)
	}
}

func TestActiveMachineConnectionFollowsPodmanPrecedence(t *testing.T) {
	connections := []podmanConnection{
		{Name: "work", URI: "ssh://core@127.0.0.1:5555/run/podman.sock", IsMachine: true},
		{Name: "podman-machine-default", URI: "ssh://core@127.0.0.1:4444/run/podman.sock", Default: true, IsMachine: true},
		{Name: "remote", URI: "ssh://remote/run/podman.sock"},
	}
	// A named connection outranks every other selection.
	if name := activeMachineConnection("work", "ssh://core@127.0.0.1:4444/run/podman.sock", connections); name != "work" {
		t.Fatalf("named connection was not selected: %q", name)
	}
	// Without a name, an explicit endpoint identifies its own machine.
	if name := activeMachineConnection("", "ssh://core@127.0.0.1:5555/run/podman.sock", connections); name != "work" {
		t.Fatalf("endpoint did not resolve its machine: %q", name)
	}
	// An endpoint that belongs to no machine must not silently fall back to an
	// unrelated local machine and mutate the wrong engine.
	if name := activeMachineConnection("", "ssh://remote/run/podman.sock", connections); name != "" {
		t.Fatalf("non-machine endpoint selected a machine: %q", name)
	}
	// Otherwise the default machine connection owns this host.
	if name := activeMachineConnection("", "", connections); name != "podman-machine-default" {
		t.Fatalf("default machine was not selected: %q", name)
	}
	// A host with no recorded connections still has a conventional machine.
	if name := activeMachineConnection("", "", nil); name != "podman-machine-default" {
		t.Fatalf("unexpected fallback machine: %q", name)
	}
}

func TestMachineInspectTargetsResolveRootfulConnections(t *testing.T) {
	// A rootful connection is named for its machine plus "-root", which
	// `podman machine inspect` does not accept, so the machine name follows it.
	if targets := machineInspectTargets("podman-machine-default-root"); len(targets) != 2 ||
		targets[0] != "podman-machine-default-root" || targets[1] != "podman-machine-default" {
		t.Fatalf("unexpected rootful inspect targets: %v", targets)
	}
	if targets := machineInspectTargets("podman-machine-default"); len(targets) != 1 {
		t.Fatalf("rootless connection gained extra targets: %v", targets)
	}
}

func TestUnixEndpointRejectsNonSocketTransports(t *testing.T) {
	if endpoint := unixEndpoint("/run/podman/podman.sock"); endpoint != "unix:///run/podman/podman.sock" {
		t.Fatalf("bare path was not normalized: %q", endpoint)
	}
	if endpoint := unixEndpoint("unix:///run/podman/podman.sock"); endpoint != "unix:///run/podman/podman.sock" {
		t.Fatalf("unix URL was not preserved: %q", endpoint)
	}
	// An ssh or TCP connection is not a socket this host can bind-mount or hand
	// to k3d, and an empty value must not become the root path.
	for _, value := range []string{"ssh://core@127.0.0.1/run/podman.sock", "tcp://127.0.0.1:2375", "", "unix://", "relative.sock"} {
		if endpoint := unixEndpoint(value); endpoint != "" {
			t.Fatalf("%q was accepted as a unix endpoint: %q", value, endpoint)
		}
	}
}

// engineSelection supplies only inert version/info/Compose answers. Its PATH
// never reaches a host engine, including when a requested executable is absent.
func engineSelection(t *testing.T, server, requested, missing, failure string, compose bool) (*runner, error, string) {
	t.Helper()
	directory := t.TempDir()
	log := filepath.Join(directory, "calls")
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	for _, name := range []string{"docker", "podman", "podman-compose"} {
		if name == missing {
			continue
		}
		body := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' %s\":$*\" >> %s\nif [ %s\":$*\" = %s ]; then exit 1; fi\ncase \"$*\" in\n'version --format {{json .Server}}') printf '%%s\\n' %s ;;\n'info'|'compose version') exit 0 ;;\n*) exit 99 ;;\nesac\n", quote(name), quote(log), quote(name), quote(failure), quote(server))
		if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory)
	r := &runner{opts: Options{Repository: directory}, env: map[string]string{"PATH": directory}}
	var err error
	if compose {
		err = r.selectEngine(context.Background(), requested)
	} else {
		err = r.selectImageEngine(context.Background(), requested)
	}
	data, readErr := os.ReadFile(log)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatal(readErr)
	}
	return r, err, string(data)
}

func TestContainerEngineSelectionHonorsServerIdentity(t *testing.T) {
	for _, tc := range []struct{ name, server, requested, want string }{
		{"Docker platform", `{"Platform":{"Name":"Docker Engine - Community"}}`, "auto", "docker"},
		{"Engine without platform", `{"Components":[{"Name":"Engine"}]}`, "auto", "docker"},
		{"Podman platform", `{"Platform":{"Name":"PoDmAn Engine"},"Components":[{"Name":"Engine"}]}`, "auto", "podman"},
		{"Podman before generic Engine", `{"Components":[{"Name":"Podman Engine"},{"Name":"Engine"}]}`, "auto", "podman"},
		{"Podman after generic Engine", `{"Components":[{"Name":"Engine"},{"Name":"Podman Engine"}]}`, "auto", "podman"},
		{"Podman overrides Docker platform", `{"Platform":{"Name":"Docker compatible"},"Components":[{"Name":"pOdMaN eNgInE"}]}`, "auto", "podman"},
		{"raw Podman", `{"Components":[{"Name":"Podman Engine"}]}`, "auto", "podman"},
		{"malformed", `{"Components":`, "auto", "podman"},
		{"wrong field type", `{"Components":"Engine"}`, "auto", "podman"},
		{"empty metadata", `{}`, "auto", "podman"},
		{"foreign engine", `{"Platform":{"Name":"other"},"Components":[{"Name":"Other Engine"}]}`, "auto", "podman"},
		{"explicit Docker refuses Podman", `{"Components":[{"Name":"Engine"},{"Name":"Podman Engine"}]}`, "docker", ""},
	} {
		for _, compose := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/compose=%t", tc.name, compose), func(t *testing.T) {
				r, err, calls := engineSelection(t, tc.server, tc.requested, "", "", compose)
				if (err != nil) != (tc.want == "") || r.engine != tc.want {
					t.Fatalf("engine=%q error=%v calls=%q", r.engine, err, calls)
				}
				if tc.requested == "docker" && strings.Contains(calls, "podman:") {
					t.Fatal("explicit Docker fell back to Podman")
				}
				if !compose && strings.Contains(calls, "compose version") {
					t.Fatal("image selection checked Compose")
				}
				if compose && r.engine == "podman" && r.env["PODMAN_COMPOSE_PROVIDER"] != filepath.Join(r.env["PATH"], "podman-compose") {
					t.Fatal("Podman provider was not pinned")
				}
			})
		}
	}
}

func TestContainerEngineSelectionRetainsCapabilityGates(t *testing.T) {
	const docker = `{"Components":[{"Name":"Engine"}]}`
	for _, tc := range []struct{ name, requested, missing, failure, imageWant, composeWant string }{
		{"Docker info failure", "docker", "", "docker:info", "", ""},
		{"Docker Compose failure", "docker", "", "docker:compose version", "docker", ""},
		{"missing Podman provider", "podman", "podman-compose", "", "podman", ""},
		{"Podman info failure", "podman", "", "podman:info", "", ""},
		{"Podman Compose failure", "podman", "", "podman:compose version", "podman", ""},
		{"failed Docker version falls back", "auto", "", "docker:version --format {{json .Server}}", "podman", "podman"},
		{"missing requested engine", "docker", "docker", "", "", ""},
	} {
		for _, compose := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/compose=%t", tc.name, compose), func(t *testing.T) {
				want := tc.imageWant
				if compose {
					want = tc.composeWant
				}
				r, err, calls := engineSelection(t, docker, tc.requested, tc.missing, tc.failure, compose)
				if (err != nil) != (want == "") || r.engine != want {
					t.Fatalf("engine=%q error=%v calls=%q", r.engine, err, calls)
				}
				if !compose && (strings.Contains(calls, "compose version") || r.env["PODMAN_COMPOSE_PROVIDER"] != "") {
					t.Fatal("image selection required a Compose provider")
				}
				if tc.requested == "podman" && strings.Contains(calls, "docker:") {
					t.Fatal("explicit Podman probed Docker")
				}
			})
		}
	}
}
