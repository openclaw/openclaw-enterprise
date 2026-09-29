package occcli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResourceRequestStopsWhenCommandContextIsCanceled(t *testing.T) {
	requestStarted := make(chan struct{}, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		requestStarted <- struct{}{}
		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)

	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	command := New(io.Discard, io.Discard)
	command.SetArgs([]string{
		"installation", "get",
		"--url", server.URL,
		"--service-key-file", keyFile,
		"--timeout-seconds", "30",
	})

	result := make(chan error, 1)
	go func() { result <- command.ExecuteContext(ctx) }()

	select {
	case <-requestStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("request never reached the server")
	}
	cancel()

	select {
	case err := <-result:
		if err == nil {
			t.Fatal("expected a canceled request to fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("command ignored context cancellation and kept waiting on the request")
	}
}
