package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	stdlog "log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

var routingManifestTestBody = []byte("kind: Namespace\nmetadata:\n  name: routing-manifest-test\n")

func routingManifestTestDigest() string {
	digest := sha256.Sum256(routingManifestTestBody)
	return hex.EncodeToString(digest[:])
}

func quickRoutingManifestRetry() routingManifestRetry {
	return routingManifestRetry{
		attempts:       8,
		firstDelay:     time.Millisecond,
		maxDelay:       5 * time.Millisecond,
		budget:         10 * time.Second,
		attemptTimeout: 5 * time.Second,
	}
}

// Serves the scripted responses in order, then the last one forever.
func routingManifestServer(t *testing.T, steps ...func(http.ResponseWriter, *http.Request)) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit := int(hits.Add(1))
		steps[min(hit, len(steps))-1](w, r)
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

func serveRoutingManifestStatus(status int) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	}
}

func serveRoutingManifest(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write(routingManifestTestBody)
}

func resetRoutingManifestConnection(w http.ResponseWriter, _ *http.Request) {
	connection, _, err := w.(http.Hijacker).Hijack()
	if err != nil {
		panic(err)
	}
	if tcp, ok := connection.(*net.TCPConn); ok {
		_ = tcp.SetLinger(0)
	}
	_ = connection.Close()
}

func truncateRoutingManifest(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Length", "4096")
	_, _ = w.Write(routingManifestTestBody[:10])
}

func hangRoutingManifest(_ http.ResponseWriter, r *http.Request) {
	<-r.Context().Done()
}

func TestDevelopmentRoutingManifestRetriesTransientFailures(t *testing.T) {
	// The reset comes first: on a reused keep-alive connection net/http
	// retries a reset GET itself, so the downloader would never see it.
	server, hits := routingManifestServer(t,
		resetRoutingManifestConnection,
		serveRoutingManifestStatus(http.StatusServiceUnavailable),
		serveRoutingManifestStatus(http.StatusTooManyRequests),
		truncateRoutingManifest,
		hangRoutingManifest,
		serveRoutingManifest,
	)
	policy := quickRoutingManifestRetry()
	policy.attemptTimeout = 2 * time.Second
	var log bytes.Buffer
	data, err := downloadDevelopmentRoutingManifest(t.Context(), &log, "test", server.URL, routingManifestTestDigest(), policy)
	if err != nil {
		t.Fatalf("download failed: %v\n%s", err, log.String())
	}
	if !bytes.Equal(data, routingManifestTestBody) {
		t.Fatalf("data = %q", data)
	}
	if got := hits.Load(); got != 6 {
		t.Fatalf("hits = %d, want 6\n%s", got, log.String())
	}
	if got := strings.Count(log.String(), "retrying in"); got != 5 {
		t.Fatalf("retry lines = %d, want 5:\n%s", got, log.String())
	}
	for _, want := range []string{"test: download routing controller manifest: HTTP 503", "HTTP 429", "unexpected EOF", "deadline exceeded", "attempt 6/8"} {
		if !strings.Contains(log.String(), want) {
			t.Fatalf("log lacks %q:\n%s", want, log.String())
		}
	}
}

func TestDevelopmentRoutingManifestStopsAfterItsAttempts(t *testing.T) {
	server, hits := routingManifestServer(t, serveRoutingManifestStatus(http.StatusBadGateway))
	policy := quickRoutingManifestRetry()
	policy.attempts = 3
	var log bytes.Buffer
	_, err := downloadDevelopmentRoutingManifest(t.Context(), &log, "test", server.URL, routingManifestTestDigest(), policy)
	if err == nil || !strings.Contains(err.Error(), "HTTP 502 (after 3 attempt(s))") {
		t.Fatalf("err = %v", err)
	}
	if got := hits.Load(); got != 3 {
		t.Fatalf("hits = %d, want 3", got)
	}
}

func TestDevelopmentRoutingManifestDoesNotRetryPermanentFailures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		step     func(http.ResponseWriter, *http.Request)
		expected string
		want     string
	}{
		{"not found", serveRoutingManifestStatus(http.StatusNotFound), routingManifestTestDigest(), "HTTP 404 (after 1 attempt(s))"},
		{"forbidden", serveRoutingManifestStatus(http.StatusForbidden), routingManifestTestDigest(), "HTTP 403 (after 1 attempt(s))"},
		{"checksum mismatch", serveRoutingManifest, strings.Repeat("0", 64), "checksum does not match"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, hits := routingManifestServer(t, tc.step)
			var log bytes.Buffer
			_, err := downloadDevelopmentRoutingManifest(t.Context(), &log, "test", server.URL, tc.expected, quickRoutingManifestRetry())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if got := hits.Load(); got != 1 {
				t.Fatalf("hits = %d, want 1", got)
			}
			if log.Len() != 0 {
				t.Fatalf("unexpected retry log:\n%s", log.String())
			}
		})
	}
}

func TestDevelopmentRoutingManifestStopsRetryingAtItsBudget(t *testing.T) {
	server, hits := routingManifestServer(t, serveRoutingManifestStatus(http.StatusServiceUnavailable))
	policy := quickRoutingManifestRetry()
	policy.attempts = 1000
	policy.firstDelay = 20 * time.Millisecond
	policy.maxDelay = 20 * time.Millisecond
	policy.budget = 200 * time.Millisecond
	var log bytes.Buffer
	started := time.Now()
	_, err := downloadDevelopmentRoutingManifest(t.Context(), &log, "test", server.URL, routingManifestTestDigest(), policy)
	elapsed := time.Since(started)
	if err == nil || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("err = %v", err)
	}
	// No retry starts after the budget; the last attempt may run past it.
	if elapsed > policy.budget+policy.maxDelay+5*time.Second {
		t.Fatalf("download ran %s past its %s budget", elapsed, policy.budget)
	}
	if got := hits.Load(); got < 2 || got > 11 {
		t.Fatalf("hits = %d, want between 2 and 11 within the budget", got)
	}
}

func TestDevelopmentRoutingManifestHonoursTheCallerDeadline(t *testing.T) {
	t.Run("during a backoff", func(t *testing.T) {
		server, hits := routingManifestServer(t, serveRoutingManifestStatus(http.StatusServiceUnavailable))
		policy := quickRoutingManifestRetry()
		policy.firstDelay = time.Minute
		policy.maxDelay = time.Minute
		policy.budget = time.Hour
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		var log bytes.Buffer
		started := time.Now()
		_, err := downloadDevelopmentRoutingManifest(ctx, &log, "test", server.URL, routingManifestTestDigest(), policy)
		if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "HTTP 503") {
			t.Fatalf("err = %v", err)
		}
		if elapsed := time.Since(started); elapsed > 10*time.Second {
			t.Fatalf("returned after %s", elapsed)
		}
		if got := hits.Load(); got != 1 {
			t.Fatalf("hits = %d, want 1", got)
		}
	})
	t.Run("during an attempt", func(t *testing.T) {
		server, hits := routingManifestServer(t, hangRoutingManifest)
		policy := quickRoutingManifestRetry()
		policy.attemptTimeout = time.Minute
		ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		var log bytes.Buffer
		_, err := downloadDevelopmentRoutingManifest(ctx, &log, "test", server.URL, routingManifestTestDigest(), policy)
		if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "(after 1 attempt(s))") {
			t.Fatalf("err = %v", err)
		}
		if got := hits.Load(); got != 1 {
			t.Fatalf("hits = %d, want 1", got)
		}
		if log.Len() != 0 {
			t.Fatalf("unexpected retry log:\n%s", log.String())
		}
	})
}

func TestDevelopmentRoutingManifestRejectsOversizedBodies(t *testing.T) {
	server, hits := routingManifestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("a"), developmentRoutingManifestLimit+1))
	})
	var log bytes.Buffer
	_, err := downloadDevelopmentRoutingManifest(t.Context(), &log, "test", server.URL, routingManifestTestDigest(), quickRoutingManifestRetry())
	if err == nil || !strings.Contains(err.Error(), "exceeds its size limit") {
		t.Fatalf("err = %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("hits = %d, want 1", got)
	}
}

func TestDevelopmentRoutingManifestDoesNotRetryARefusedCertificate(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		serveRoutingManifest(w, r)
	}))
	server.Config.ErrorLog = stdlog.New(io.Discard, "", 0)
	t.Cleanup(server.Close)
	var log bytes.Buffer
	_, err := downloadDevelopmentRoutingManifest(t.Context(), &log, "test", server.URL, routingManifestTestDigest(), quickRoutingManifestRetry())
	if err == nil || !strings.Contains(err.Error(), "(after 1 attempt(s))") {
		t.Fatalf("err = %v", err)
	}
	// The handshake fails before any request reaches the handler.
	if got := hits.Load(); got != 0 {
		t.Fatalf("hits = %d, want 0", got)
	}
	if log.Len() != 0 {
		t.Fatalf("unexpected retry log:\n%s", log.String())
	}
}

func TestTransientRoutingManifestErrors(t *testing.T) {
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	for _, tc := range []struct {
		name string
		ctx  context.Context
		err  error
		want bool
	}{
		{"HTTP/2 stream reset", t.Context(), errors.New("stream error: stream ID 3; INTERNAL_ERROR; received from peer"), true},
		{"connection reset", t.Context(), &net.OpError{Op: "read", Err: syscall.ECONNRESET}, true},
		{"attempt timeout", t.Context(), context.DeadlineExceeded, true},
		{"caller cancelled", cancelled, &net.OpError{Op: "read", Err: syscall.ECONNRESET}, false},
		{"unknown authority", t.Context(), &url.Error{Op: "Get", URL: "https://example.test", Err: &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}}, false},
		{"hostname mismatch", t.Context(), &url.Error{Op: "Get", URL: "https://example.test", Err: x509.HostnameError{Host: "example.test"}}, false},
	} {
		if got := transientRoutingManifestError(tc.ctx, tc.err); got != tc.want {
			t.Errorf("%s: transient = %v, want %v", tc.name, got, tc.want)
		}
	}
}
