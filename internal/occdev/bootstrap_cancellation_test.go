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
			state := &developmentState{
				Repository: t.TempDir(), ComposeProject: "bootstrap-fixture",
				PlatformNamespace: "bootstrap-fixture", directory: privateBootstrapDirectory(t),
			}
			state.KeyPath = filepath.Join(state.directory, "exported-key.json")
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			if err := r.prepareBootstrapCredentials(state); err != nil {
				t.Fatal(err)
			}
			// Real local credential files and HTTP transport; the server deliberately
			// never authorizes the key or emits a successful OCC response.
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
