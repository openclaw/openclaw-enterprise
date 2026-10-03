package occdev

import (
	"bytes"
	"context"
	"errors"
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
