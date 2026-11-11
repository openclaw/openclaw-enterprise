package occdev

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestPublishesLoopbackPortMatchesHostBindings(t *testing.T) {
	for _, tc := range []struct {
		published string
		port      int
		want      bool
	}{
		{"127.0.0.1:3000->3000/tcp", 3000, true},
		{"0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp", 3000, true},
		{"[::]:8443->8443/tcp", 8443, true},
		{"127.0.0.1:2999-3001->2999-3001/tcp", 3000, true},
		{"127.0.0.1:55432->5432/tcp, 127.0.0.1:6443->6443/tcp", 6443, true},
		// The container port is not the host port.
		{"127.0.0.1:4000->3000/tcp", 3000, false},
		// Exposed, not published.
		{"3000/tcp", 3000, false},
		// Another specific address does not hold the loopback port.
		{"192.0.2.10:3000->3000/tcp", 3000, false},
		// A UDP or SCTP publication does not hold the TCP port.
		{"0.0.0.0:3000->3000/udp", 3000, false},
		{"127.0.0.1:2999-3001->2999-3001/udp, [::]:3000->3000/sctp", 3000, false},
		{"0.0.0.0:3000->3000/udp, 0.0.0.0:3000->3000/tcp", 3000, true},
		{"", 3000, false},
	} {
		if got := publishesLoopbackPort(tc.published, tc.port); got != tc.want {
			t.Errorf("publishesLoopbackPort(%q, %d) = %t, want %t", tc.published, tc.port, got, tc.want)
		}
	}
}

func TestContainerLabelReadsDockerAndPodmanFormats(t *testing.T) {
	for _, labels := range []string{
		"com.docker.compose.service=controller,com.docker.compose.project=openclaw-enterprise-development",
		"map[com.docker.compose.project:openclaw-enterprise-development com.docker.compose.service:controller]",
	} {
		if project, ok := containerLabel(labels, "com.docker.compose.project"); !ok || project != "openclaw-enterprise-development" {
			t.Errorf("containerLabel(%q) = %q, %t", labels, project, ok)
		}
		if _, ok := containerLabel(labels, "k3d.cluster"); ok {
			t.Errorf("containerLabel(%q) found an absent label", labels)
		}
	}
}

func TestDevelopmentHostPortPreflightNamesTheLikelyHolder(t *testing.T) {
	ports := []developmentHostPort{{3000, "OPENCLAW_DEV_PORT"}, {8443, "OCC_DEVELOPMENT_BROWSER_PORT"}, {6443, "OCC_DEVELOPMENT_KUBERNETES_API_PORT"}}
	for _, tc := range []struct {
		name, listing string
		starting      developmentStack
		want          []string
		absent        []string
	}{
		{
			// The stack holds several ports; the API port is named whatever the listing order.
			name:    "default Docker-compatible stack",
			listing: `printf 'openclaw-enterprise-development-browser-proxy-1\t127.0.0.1:8443->8443/tcp\tcom.docker.compose.project=openclaw-enterprise-development\nopenclaw-enterprise-development-postgres-1\t127.0.0.1:55432->5432/tcp\tcom.docker.compose.project=openclaw-enterprise-development\nopenclaw-enterprise-development-controller-1\t127.0.0.1:3000->3000/tcp\tcom.docker.compose.project=openclaw-enterprise-development,com.docker.compose.service=controller\n'`,
			want: []string{
				"host port 127.0.0.1:3000 (OPENCLAW_DEV_PORT) is already published by container openclaw-enterprise-development-controller-1",
				"a Docker-compatible development stack (Compose project openclaw-enterprise-development) may be running; stop it with OCC_DEVELOPMENT_COMPUTE_DRIVER=docker occ dev down",
				"or set OPENCLAW_DEV_PORT to a free port",
			},
		},
		{
			name:    "Compose control plane with Kubernetes Compute",
			listing: `printf 'openclaw-enterprise-development-kubernetes-browser-proxy-1\t127.0.0.1:8443->8443/tcp\tcom.docker.compose.project=openclaw-enterprise-development-kubernetes\n'`,
			want:    []string{"(OCC_DEVELOPMENT_BROWSER_PORT)", "stop it with OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes occ dev down"},
		},
		{
			name:    "another k3d development cluster",
			listing: `printf 'k3d-occ-dev-other-serverlb\t0.0.0.0:3000->30080/tcp, 127.0.0.1:6443->6443/tcp\tapp=k3d,k3d.cluster=occ-dev-other,k3d.role=loadbalancer\n'`,
			want:    []string{"container k3d-occ-dev-other-serverlb", "another Kubernetes development stack (k3d cluster occ-dev-other)"},
		},
		{
			// Restarting the stack that holds the port: stop it, never move the port.
			name:     "the Kubernetes Compute control plane being started",
			listing:  `printf 'openclaw-enterprise-development-kubernetes-controller-1\t127.0.0.1:3000->3000/tcp\tcom.docker.compose.project=openclaw-enterprise-development-kubernetes\n'`,
			starting: developmentStack{composeProject: "openclaw-enterprise-development-kubernetes", cluster: "occ-dev-new"},
			want:     []string{"the Compose control plane being started (Compose project openclaw-enterprise-development-kubernetes) is already running; stop it with OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes occ dev down, then start it again"},
			absent:   []string{"may be running", "to a free port"},
		},
		{
			name:     "the k3d cluster being started",
			listing:  `printf 'k3d-occ-dev-fixed-serverlb\t127.0.0.1:6443->6443/tcp\tapp=k3d,k3d.cluster=occ-dev-fixed\n'`,
			starting: developmentStack{cluster: "occ-dev-fixed"},
			want:     []string{"the Kubernetes development stack being started (k3d cluster occ-dev-fixed) is already running", "then start it again"},
			absent:   []string{"another", "to a free port"},
		},
		{
			name:    "unrelated container",
			listing: `printf 'web\t[::]:6443->443/tcp\t\n'`,
			want:    []string{"(OCC_DEVELOPMENT_KUBERNETES_API_PORT) is already published by container web; stop that container"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeEngine(t, "docker", `"ps --format "*) `+tc.listing+` ;;
`)
			r := &runner{engine: "docker", env: newRunner(Options{}).env}
			err := r.checkDevelopmentHostPorts(context.Background(), tc.starting, ports)
			if err == nil {
				t.Fatal("a held port was not refused")
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not contain %q", err, want)
				}
			}
			for _, absent := range tc.absent {
				if strings.Contains(err.Error(), absent) {
					t.Errorf("error %q contains %q", err, absent)
				}
			}
		})
	}
	t.Run("free ports", func(t *testing.T) {
		fakeEngine(t, "docker", `"ps --format "*) printf 'other\t127.0.0.1:4000->3000/tcp\t\n' ;;
`)
		r := &runner{engine: "docker", env: newRunner(Options{}).env}
		if err := r.checkDevelopmentHostPorts(context.Background(), developmentStack{}, ports); err != nil {
			t.Fatalf("free ports were refused: %v", err)
		}
	})
	t.Run("engine cannot list containers", func(t *testing.T) {
		// Best effort: k3d's own error still reports a clash.
		fakeEngine(t, "docker", "")
		r := &runner{engine: "docker", env: newRunner(Options{}).env}
		if err := r.checkDevelopmentHostPorts(context.Background(), developmentStack{}, ports); err != nil {
			t.Fatalf("a failed listing refused startup: %v", err)
		}
	})
}

func TestK3dRolledBackCleanlyNeedsK3dRollbackAndNoLeftovers(t *testing.T) {
	rolledBack := k3dCreateError(errors.New("exit status 1"), []byte("ERRO[0009] Failed Cluster Start: Bind for 127.0.0.1:3000 failed: port is already allocated\nFATA[0009] Cluster creation FAILED, all changes have been rolled back!\n"), false)
	notRolledBack := k3dCreateError(errors.New("exit status 1"), []byte("FATA[0009] Cluster creation FAILED, also FAILED to rollback changes!\n"), false)
	for _, tc := range []struct {
		name       string
		err        error
		clusters   string
		containers string
		want       bool
	}{
		{"k3d rolled back and nothing remains", rolledBack, "[]", "", true},
		{"k3d did not roll back", notRolledBack, "[]", "", false},
		{"not a k3d create failure", errors.New("cancelled"), "[]", "", false},
		{"cluster still listed", rolledBack, `[{"name":"occ-dev-test"}]`, "", false},
		{"node container remains", rolledBack, "[]", "echo 0123456789ab", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeProfileCommands(t, map[string]string{
				"k3d":    `"cluster list -o json") echo '` + tc.clusters + `' ;;`,
				"docker": `"ps --all --quiet --filter label=k3d.cluster=occ-dev-test") ` + tc.containers + ` ;;`,
			})
			r := &runner{engine: "docker", env: newRunner(Options{}).env}
			if got := r.k3dRolledBackCleanly(context.Background(), tc.err, "occ-dev-test"); got != tc.want {
				t.Fatalf("k3dRolledBackCleanly = %t, want %t", got, tc.want)
			}
		})
	}
}
