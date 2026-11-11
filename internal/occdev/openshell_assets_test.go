package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenShellArchiveRetriesWithoutAppendingPartialBytes(t *testing.T) {
	t.Parallel()
	// A release outage followed by an interrupted transfer must still produce
	// exactly the pinned archive, never a concatenation of download attempts.
	server, hits := routingManifestServer(t,
		serveRoutingManifestStatus(http.StatusServiceUnavailable),
		truncateRoutingManifest,
		serveRoutingManifest,
	)
	destination := filepath.Join(t.TempDir(), "source.tar.gz")
	if err := downloadVerified(t.Context(), server.URL, destination, routingManifestTestDigest()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(data, routingManifestTestBody) {
		t.Fatalf("archive = %q, error = %v", data, err)
	}
	info, err := os.Stat(destination)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("archive must remain private: info = %v, error = %v", info, err)
	}
	if got := hits.Load(); got != 3 {
		t.Fatalf("requests = %d, want 3", got)
	}
}

func TestOpenShellArchiveBoundsAStalledAttempt(t *testing.T) {
	t.Parallel()
	// Exercise the shipped attempt deadline, without a test-only timeout knob.
	// A responsive second request must succeed before the parent deadline.
	server, hits := routingManifestServer(t, hangRoutingManifest, serveRoutingManifest)
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	destination := filepath.Join(t.TempDir(), "source.tar.gz")
	if err := downloadVerified(ctx, server.URL, destination, routingManifestTestDigest()); err != nil {
		t.Fatal(err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("requests = %d, want 2", got)
	}
}

func TestOpenShellArchiveRejectsPermanentFailuresAndPreservesExistingFiles(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name     string
		status   int
		digest   string
		existing bool
		want     string
	}{
		{"forbidden", http.StatusForbidden, routingManifestTestDigest(), false, "HTTP 403"},
		{"not found", http.StatusNotFound, routingManifestTestDigest(), false, "HTTP 404"},
		{"checksum", http.StatusOK, strings.Repeat("0", 64), false, "checksum mismatch"},
		{"existing file", http.StatusOK, routingManifestTestDigest(), true, "file exists"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, hits := routingManifestServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				serveRoutingManifest(w, r)
			})
			destination := filepath.Join(t.TempDir(), "source.tar.gz")
			if tc.existing {
				if err := os.WriteFile(destination, []byte("owned by another invocation"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err := downloadVerified(t.Context(), server.URL, destination, tc.digest)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
			if got := hits.Load(); got != 1 {
				t.Fatalf("requests = %d, want 1", got)
			}
			data, err := os.ReadFile(destination)
			if tc.existing {
				if err != nil || string(data) != "owned by another invocation" {
					t.Fatalf("existing archive changed: %q, %v", data, err)
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("failed download retained bytes: %q, %v", data, err)
			}
		})
	}
}

func TestOpenShellArchiveCancellationRemovesPartialDownload(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	server, hits := routingManifestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(routingManifestTestBody[:10])
		w.(http.Flusher).Flush()
		// Wait until the client has created its private destination, then cancel
		// while the body is incomplete so cleanup follows file creation.
		<-r.Context().Done()
	})
	destination := filepath.Join(t.TempDir(), "source.tar.gz")
	done := make(chan error, 1)
	go func() { done <- downloadVerified(ctx, server.URL, destination, routingManifestTestDigest()) }()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(destination); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("download ended before cancellation: %v", err)
		case <-deadline.C:
			t.Fatal("download did not create its destination")
		case <-ticker.C:
		}
	}
	cancel()
	err := <-done
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	// The launcher must still identify the original cancellation rather than
	// misreporting it as an OpenShell preparation failure.
	stage, cleanupFailed := startupFailureDetails(startupError("openshell-preparation", err))
	if stage != "canceled" || cleanupFailed {
		t.Fatalf("startup failure = %s, cleanup failed = %t", stage, cleanupFailed)
	}
	if _, err := os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial archive was retained: %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("requests = %d, want 1", got)
	}
}

func TestOpenShellArchiveStreamsBeyondTheManifestSizeLimit(t *testing.T) {
	t.Parallel()
	// Source archives are streamed to disk; the manifest's in-memory size cap
	// must not reject a valid, larger pinned archive.
	chunk := bytes.Repeat([]byte("a"), 1024*1024)
	hash := sha256.New()
	for range 33 {
		_, _ = hash.Write(chunk)
	}
	server, _ := routingManifestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		for range 33 {
			_, _ = w.Write(chunk)
		}
	})
	destination := filepath.Join(t.TempDir(), "source.tar.gz")
	if err := downloadVerified(t.Context(), server.URL, destination, hex.EncodeToString(hash.Sum(nil))); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(destination)
	if err != nil || info.Size() != 33*1024*1024 {
		t.Fatalf("archive size: info = %v, error = %v", info, err)
	}
}
