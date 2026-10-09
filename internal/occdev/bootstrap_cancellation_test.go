package occdev

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBootstrapAuthorizationStopsWithStartupContext(t *testing.T) {
	for _, controlPlane := range []string{"compose", "kubernetes"} {
		t.Run(controlPlane, func(t *testing.T) {
			key := filepath.Join(t.TempDir(), "bootstrap.json")
			if err := os.WriteFile(key, []byte(`{"data":{"key":"synthetic-bootstrap-key"},"meta":{"installationId":"ins_00000000-0000-4000-8000-000000000001"}}`), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("OCC_TEST_BOOTSTRAP_KEY", key)
			// Only the pre-request key-copy plumbing is a fixture. The production
			// bootstrap reader and HTTP client consume real files and a live socket;
			// the server never emits a successful OCC response or authorizes a key.
			fakeProfileCommands(t, map[string]string{
				"docker": `
"compose "*) echo bootstrap-fixture ;;
"cp bootstrap-fixture:/var/lib/openclaw/bootstrap/initial-admin-service-key.json "*) cp "$OCC_TEST_BOOTSTRAP_KEY" "$3" ;;
`,
				"kubectl": `
"apply -f "*|*"wait --for=condition=Ready "*|*"delete pod bootstrap-key-reader "*) ;;
*"initial-admin-service-key.json"*) cat "$OCC_TEST_BOOTSTRAP_KEY" ;;
*"initial-admin-password"*) printf '%s' synthetic-bootstrap-password ;;
`,
			})
			state := &developmentState{
				Repository: t.TempDir(), ComposeProject: "bootstrap-fixture",
				PlatformNamespace: "bootstrap-fixture", directory: t.TempDir(),
			}
			state.KeyPath = filepath.Join(state.directory, "exported-key.json")
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			started, disconnected := make(chan struct{}), make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodGet || request.URL.Path != "/installation" {
					t.Errorf("unexpected authorization request: %s %s", request.Method, request.URL.Path)
				}
				close(started)
				<-request.Context().Done()
				close(disconnected)
			}))
			t.Cleanup(func() {
				server.CloseClientConnections()
				server.Close()
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() {
				var err error
				if controlPlane == "compose" {
					_, _, err = r.copyAndVerifyKey(ctx, state, server.URL)
				} else {
					_, _, err = r.copyAndVerifyKubernetesKey(ctx, state, "controller:fixture", server.URL, time.Second)
				}
				result <- err
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("bootstrap reader did not reach its HTTP authorization request")
			}
			// Interrupt after the real request starts, while the controller has
			// supplied no response. Cancellation must end both caller and socket.
			cancel()
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("expected startup cancellation, got %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("bootstrap authorization continued after startup was canceled")
			}
			select {
			case <-disconnected:
			case <-time.After(time.Second):
				t.Fatal("bootstrap authorization left its HTTP request connected")
			}
			if _, err := os.Stat(state.KeyPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("canceled authorization must not export the final key: %v", err)
			}
		})
	}
}
