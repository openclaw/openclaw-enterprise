package occclient

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestUnauthorizedDiagnostic(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "key.json")
	const key = "synthetic-service-key"
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"`+key+`"}}`), 0600); err != nil {
		t.Fatal(err)
	}

	const endpointAdvice = "The configured endpoint or gateway returned HTTP 401. Check that OCC_URL (or --url) points to the origin that serves the OCC API."
	tests := []struct {
		name        string
		contentType string
		challenge   string
		body        string
		code        string
		want        string
	}{
		{
			name:        "OCC rejects key",
			contentType: "application/json",
			body:        `{"error":{"code":"UNAUTHENTICATED","message":"A valid session cookie or service API key is required: the credential sent is missing, invalid, expired, or revoked. Sign in again, or use a current service API key."}}`,
			code:        "UNAUTHENTICATED",
			want:        "OCC rejected the service key in " + keyFile + ": it is invalid, expired or revoked. Ask an Installation administrator for a new key.",
		},
		{
			name:        "gateway issues Basic challenge",
			contentType: "text/plain",
			challenge:   `Basic realm="synthetic-gateway"`,
			body:        "gateway returned a login URL with a synthetic secret",
			want:        endpointAdvice,
		},
		{
			name:        "unrecognized JSON error",
			contentType: "application/json",
			body:        `{"error":{"code":"GATEWAY_AUTH_REQUIRED","message":"synthetic token","details":[{"path":"synthetic","code":"PRIVATE","message":"synthetic detail"}]}}`,
			code:        "GATEWAY_AUTH_REQUIRED",
			want:        endpointAdvice,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodGet || r.URL.Path != "/installation" || r.Header.Get("x-api-key") != key {
					t.Error("expected the normal authenticated Installation GET")
				}
				w.Header().Set("Content-Type", tt.contentType)
				if tt.challenge != "" {
					w.Header().Set("WWW-Authenticate", tt.challenge)
				}
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, tt.body)
			}))
			defer server.Close()

			client, err := New(Config{URL: server.URL, ServiceKeyFile: keyFile, Timeout: 3 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.GetInstallation()
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized || apiErr.Code != tt.code {
				t.Fatalf("expected HTTP 401 API error with code %q, got %v", tt.code, err)
			}
			if got := err.Error(); got != tt.want {
				t.Errorf("diagnostic = %q, want %q", got, tt.want)
			}
			if got := requests.Load(); got != 1 {
				t.Errorf("requests = %d, want 1", got)
			}
		})
	}
}
