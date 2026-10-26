//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occcli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestServiceKeyCreateKeepsOwnerAccessWithRestrictiveUmask(t *testing.T) {
	if endpoint := os.Getenv("OCC_TEST_KEY_MODE_ENDPOINT"); endpoint != "" {
		// The child confines the process-wide kernel mask to this CLI invocation.
		syscall.Umask(0o777)
		var out bytes.Buffer
		command := New(&out, &bytes.Buffer{})
		command.SetArgs([]string{"--url", endpoint, "--service-key-file", os.Getenv("OCC_TEST_KEY_MODE_ADMIN"), "service-key", "create", "--service-principal", "spn_example", "--name", "synthetic", "--out", os.Getenv("OCC_TEST_KEY_MODE_OUTPUT")})
		if err := command.Execute(); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), "synthetic-issued-key") {
			t.Fatal("issued key appeared in stdout")
		}
		return
	}
	requests := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests <- request.Method + " " + request.URL.Path
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"data":{"id":"key_example","servicePrincipalId":"spn_example","name":"synthetic","key":"synthetic-issued-key"},"meta":{"requestId":"synthetic"}}`))
	}))
	defer server.Close()
	directory := t.TempDir()
	admin := filepath.Join(directory, "admin.json")
	if err := os.WriteFile(admin, []byte(`{"data":{"key":"synthetic-admin-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "issued.json")
	child := exec.Command(os.Args[0], "-test.run=^TestServiceKeyCreateKeepsOwnerAccessWithRestrictiveUmask$")
	child.Env = append(os.Environ(), "OCC_TEST_KEY_MODE_ENDPOINT="+server.URL, "OCC_TEST_KEY_MODE_ADMIN="+admin, "OCC_TEST_KEY_MODE_OUTPUT="+output)
	if text, err := child.CombinedOutput(); err != nil {
		t.Fatalf("CLI child: %v\n%s", err, text)
	}
	if got := <-requests; got != "POST /api/auth/service-keys" {
		t.Fatalf("request = %s", got)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("issued key mode = %04o; want0600 even with umask0777", info.Mode().Perm())
	}
	data, err := os.ReadFile(output)
	if err != nil || !bytes.Contains(data, []byte(`"key":"synthetic-issued-key"`)) {
		t.Fatalf("issued key not readable as an issuance envelope: %v", err)
	}
}
