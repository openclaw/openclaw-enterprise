package occcli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRateLimitedErrorNamesTheRetryAfterDelay(t *testing.T) {
	for _, test := range []struct {
		retryAfter, body, want string
	}{
		{"7", `{"error":{"code":"RUNTIME_LOGS_RATE_LIMITED","message":"Too many runtime log requests. Wait for Retry-After and try again."}}`,
			"OCC operation failed (HTTP 429): RUNTIME_LOGS_RATE_LIMITED: Too many runtime log requests. Wait for Retry-After and try again. Retry after 7s."},
		{"120", `not json`, "OCC operation failed (HTTP 429). Retry after 120s."},
		{"", `{"error":{"code":"RATE_LIMITED","message":"Slow down."}}`, "OCC operation failed (HTTP 429): RATE_LIMITED: Slow down."},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			if test.retryAfter != "" {
				writer.Header().Set("retry-after", test.retryAfter)
			}
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(test.body))
		}))
		keyFile := filepath.Join(t.TempDir(), "service-key.json")
		if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		command := New(&out, &bytes.Buffer{})
		command.SetArgs([]string{"--url", server.URL, "--service-key-file", keyFile, "--namespace", testNamespaceID, "agent", "list"})
		err := command.Execute()
		server.Close()
		if err == nil || err.Error() != test.want {
			t.Errorf("Retry-After %q: error = %v, want %q", test.retryAfter, err, test.want)
		}
		if strings.TrimSpace(out.String()) != "" {
			t.Errorf("Retry-After %q: stdout = %q, want nothing", test.retryAfter, out.String())
		}
	}
}
