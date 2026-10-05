package occdev

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

func TestDevelopmentNamespaceDeadlineCancelsHTTPRequest(t *testing.T) {
	cancelled := make(chan struct{})
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) > 1 {
			fmt.Fprint(w, `{"data":{"id":"proof","status":"ready"},"meta":{}}`)
			return
		}
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(time.Second):
			fmt.Fprint(w, `{"data":{"id":"proof","status":"ready"},"meta":{}}`)
		}
	}))
	defer server.Close()
	client := readinessClient(t, server.URL)
	started := time.Now()
	err := waitForDevelopmentNamespace(context.Background(), client, "proof", 100*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	if time.Since(started) > 700*time.Millisecond {
		t.Fatal("request outlived readiness deadline")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("HTTP request was not cancelled")
	}
	// Request-scoped cancellation must not poison the client's subsequent calls.
	if _, err := client.GetNamespace("proof"); err != nil {
		t.Fatal(err)
	}
}

func TestDevelopmentNamespaceParentCancellation(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(time.Second):
			fmt.Fprint(w, `{"data":{"id":"proof","status":"ready"},"meta":{}}`)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := readinessClient(t, server.URL)
	go func() { <-started; cancel() }()
	err := waitForDevelopmentNamespace(ctx, client, "proof", 5*time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("HTTP request was not cancelled")
	}
}

func TestDevelopmentNamespaceReady(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":{"id":"proof","status":"ready"},"meta":{}}`)
	}))
	defer server.Close()
	if err := waitForDevelopmentNamespace(context.Background(), readinessClient(t, server.URL), "proof", time.Second); err != nil {
		t.Fatal(err)
	}
}
func readinessClient(t *testing.T, url string) *occclient.Client {
	t.Helper()
	key := filepath.Join(t.TempDir(), "key.json")
	if err := os.WriteFile(key, []byte(`{"data":{"key":"synthetic-proof"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := occclient.New(occclient.Config{URL: url, ServiceKeyFile: key, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestReadinessContextCancelsRepositoryDiscovery(t *testing.T) {
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(time.Second):
			fmt.Fprint(w, `{"data":[],"meta":{}}`)
		}
	}))
	defer server.Close()
	err := waitForDevelopmentRepositories(context.Background(), readinessClient(t, server.URL), "proof", map[string]map[string]bool{}, 100*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("repository request was not cancelled")
	}
}
