package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// Run the real sender in a child so each process loads its own OS trust
	// bundle. No transport injection or verification bypass is involved.
	if len(os.Args) > 1 && os.Args[1] == "--origin" {
		main()
		return
	}
	os.Exit(m.Run())
}

func TestRejectsNonOriginArguments(t *testing.T) {
	for _, origin := range []string{
		"http://localhost", "https://127.0.0.1", "https://[::1]",
		"https://user@localhost", "https://localhost/v1",
		"https://localhost/?", "https://localhost#", "https://localhost:",
		"https://localhost:0", "https://localhost:65536",
	} {
		t.Run(origin, func(t *testing.T) {
			var ready strings.Builder
			if err := run([]string{"--origin", origin}, &ready); err == nil || ready.Len() != 0 {
				t.Fatalf("invalid origin produced readiness")
			}
		})
	}
}

func TestSender(t *testing.T) {
	const first = "event: response.created\ndata: {}\n\n"
	const second = "event: response.completed\ndata: {}\n\n"
	var requests atomic.Int32
	var redirects atomic.Int32
	var wrongHeaders atomic.Bool
	finish := make(chan struct{})
	canceled := make(chan struct{})
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	origin, caFile := tlsOrigin(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirected" {
			redirects.Add(1)
			return
		}
		requests.Add(1)
		if r.Method != "POST" || r.URL.RequestURI() != "/v1/responses" ||
			r.Header.Get("Authorization") != "Bearer oce:request-authorized:model" ||
			r.Header.Get("Content-Type") != "application/json" ||
			r.Header.Get("Accept") != "text/event-stream" ||
			r.Header.Get("Accept-Encoding") != "identity" ||
			r.Header.Get("Traceparent") != "" || r.Header.Get("X-Stainless-Runtime") != "" || r.Header.Get("User-Agent") != "" ||
			r.Header.Get("Session_id") != "" || r.Header.Get("X-Client-Request-Id") != "" {
			wrongHeaders.Store(true)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return
		}
		switch string(body) {
		case `{"redirect":true}`:
			http.Redirect(w, r, "/redirected", http.StatusTemporaryRedirect)
		case `{"compressed":true}`:
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = io.WriteString(w, "unapproved encoding")
		case `{"cancel":true}`:
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, first)
			_ = http.NewResponseController(w).Flush()
			select {
			case <-r.Context().Done():
				close(canceled)
			case <-ctx.Done():
			}
		case `{"stream":true}`:
			w.Header().Set("Set-Cookie", "discarded=yes")
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, first)
			_ = http.NewResponseController(w).Flush()
			select {
			case <-finish:
				_, _ = io.WriteString(w, second)
			case <-ctx.Done():
			}
		default:
			http.Error(w, "unexpected test request", http.StatusBadRequest)
		}
	})
	local := startSender(t, ctx, origin, caFile)
	send := func(t *testing.T, method, path, body string, alter func(*http.Request)) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, local+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer oce:request-authorized:model")
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		req.Header.Set("Traceparent", "synthetic-local-trace")
		req.Header.Set("X-Stainless-Runtime", "node")
		req.Header.Set("Session_id", "local-session")
		req.Header.Set("X-Client-Request-Id", "local-request")
		if alter != nil {
			alter(req)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}

	for _, tc := range []struct {
		name, method, path string
		want               int
		alter              func(*http.Request)
	}{
		{"query", "POST", "/v1/responses?model=other", 404, nil},
		{"empty query", "POST", "/v1/responses?", 404, nil},
		{"escaped path", "POST", "/v1/re%73ponses", 404, nil},
		{"different route", "POST", "/v1/chat/completions", 404, nil},
		{"wrong method", "GET", "/v1/responses", 405, nil},
		{"unrelated Host", "POST", "/v1/responses", 404, func(r *http.Request) { r.Host = "other.example" }},
		{"absent authorization", "POST", "/v1/responses", 401, func(r *http.Request) { r.Header.Del("Authorization") }},
		{"other authorization", "POST", "/v1/responses", 401, func(r *http.Request) { r.Header.Set("Authorization", "Bearer synthetic") }},
		{"duplicate authorization", "POST", "/v1/responses", 401, func(r *http.Request) { r.Header.Add("Authorization", "Bearer synthetic") }},
		{"cookie", "POST", "/v1/responses", 400, func(r *http.Request) { r.Header.Set("Cookie", "example=value") }},
		{"proxy credential", "POST", "/v1/responses", 400, func(r *http.Request) { r.Header.Set("Proxy-Authorization", "Basic synthetic") }},
		{"origin override", "POST", "/v1/responses", 400, func(r *http.Request) { r.Header.Set("X-Forwarded-Host", "other.example") }},
		{"encoded request", "POST", "/v1/responses", 400, func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := send(t, tc.method, tc.path, `{"stream":true}`, tc.alter)
			if resp.StatusCode != tc.want {
				t.Errorf("got status %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
	for _, chunked := range []bool{false, true} {
		resp := send(t, "POST", "/v1/responses", strings.Repeat("a", 1024*1024+1), func(r *http.Request) {
			if chunked {
				r.ContentLength = -1
			}
		})
		if resp.StatusCode != 413 {
			t.Fatalf("oversized body: got %d, want 413 (chunked %t)", resp.StatusCode, chunked)
		}
		resp.Body.Close()
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("%d rejected requests reached the origin", n)
	}

	for _, body := range []string{`{"redirect":true}`, `{"compressed":true}`} {
		resp := send(t, "POST", "/v1/responses", body, nil)
		if resp.StatusCode != 502 || resp.Header.Get("Location") != "" {
			t.Fatalf("unsupported response escaped with status %d", resp.StatusCode)
		}
		resp.Body.Close()
	}
	if redirects.Load() != 0 {
		t.Fatal("sender followed redirect")
	}

	resp := send(t, "POST", "/v1/responses", `{"stream":true}`, nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" ||
		resp.Header.Get("Set-Cookie") != "" {
		t.Fatalf("unexpected SSE status or headers: %d", resp.StatusCode)
	}
	checkSSEPrefix(t, resp, first)
	close(finish)
	remainder, err := io.ReadAll(resp.Body)
	if err != nil || string(remainder) != second {
		t.Fatalf("remaining SSE changed or truncated: %v", err)
	}
	resp.Body.Close()

	resp = send(t, "POST", "/v1/responses", `{"cancel":true}`, nil)
	checkSSEPrefix(t, resp, first)
	resp.Body.Close()
	select {
	case <-canceled:
	case <-ctx.Done():
		t.Fatal("closing the local stream left the origin request alive")
	}
	if wrongHeaders.Load() || requests.Load() != 4 {
		t.Fatal("origin did not receive the exact requests with synthesized headers")
	}

	untrusted := startSender(t, ctx, origin, "")
	req, err := http.NewRequestWithContext(ctx, "POST", untrusted+"/v1/responses", strings.NewReader(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer oce:request-authorized:model")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 502 || requests.Load() != 4 {
		t.Fatal("origin with untrusted TLS was accepted")
	}
}

func checkSSEPrefix(t *testing.T, resp *http.Response, prefix string) {
	t.Helper()
	chunk := make([]byte, len(prefix))
	if _, err := io.ReadFull(resp.Body, chunk); err != nil || string(chunk) != prefix {
		t.Fatalf("first SSE bytes changed or were not flushed: %v", err)
	}
}

func startSender(t *testing.T, ctx context.Context, origin, caFile string) string {
	t.Helper()
	cmd := exec.CommandContext(ctx, os.Args[0], "--origin", origin)
	cmd.Env = []string{"SSL_CERT_FILE=" + caFile}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if stderr.Len() != 0 {
			t.Errorf("sender emitted diagnostics during HTTP handling: %q", stderr.String())
		}
	})
	line, err := bufio.NewReader(stdout).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Port int `json:"port"`
	}
	if err := json.Unmarshal(line, &ready); err != nil || ready.Port < 1 || ready.Port > 65535 {
		t.Fatalf("invalid sender readiness: %v", err)
	}
	return "http://127.0.0.1:" + strconv.Itoa(ready.Port)
}

func tlsOrigin(t *testing.T, handler http.HandlerFunc) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		DNSNames:              []string{"localhost"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		BasicConstraintsValid: true,
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	caFile := filepath.Join(t.TempDir(), "test-ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	origin := httptest.NewUnstartedServer(handler)
	origin.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	origin.StartTLS()
	t.Cleanup(origin.Close)
	return strings.Replace(origin.URL, "127.0.0.1", "localhost", 1), caFile
}
