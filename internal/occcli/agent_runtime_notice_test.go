package occcli

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRuntimeFallbackNoticePunctuation(t *testing.T) {
	for _, message := range []string{"The runtime read is not authorized", "The runtime read is not authorized."} {
		t.Run(message, func(t *testing.T) {
			active := "rev_00000000-0000-4000-8000-000000000001"
			newer := "rev_00000000-0000-4000-8000-000000000002"
			stub := &runtimeLogStub{t: t, activeID: active,
				revisions: `[{"id":"rev_00000000-0000-4000-8000-000000000002","revision":2},{"id":"rev_00000000-0000-4000-8000-000000000001","revision":1}]`,
			}
			// Runtime permission can be denied while the same caller can still read logs.
			// The real CLI must preserve the failure reason and explicit retry target.
			key := rand.Text()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("x-api-key") != key {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/runtime/logs") {
					logPage("", logLine(1, "info", "ready"))(w, r.URL.Query())
					return
				}
				if strings.HasSuffix(r.URL.Path, "/"+newer+"/runtime") {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusForbidden)
					_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "FORBIDDEN", "message": message}})
					return
				}
				stub.serve(w, r)
			}))
			defer server.Close()
			encodedKey, err := json.Marshal(map[string]any{"data": map[string]string{"key": key}})
			if err != nil {
				t.Fatal(err)
			}
			keyFile := writeKeyFile(t, string(encodedKey))
			var output, notices bytes.Buffer
			command := New(&output, &notices)
			command.SetArgs([]string{"--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_00000000-0000-4000-8000-000000000001",
				"agent", "logs", "agt_00000000-0000-4000-8000-000000000001", "--source", "gateway"})
			if err := command.Execute(); err != nil {
				t.Fatal(err)
			}
			got := strings.TrimSpace(notices.String())
			if strings.Contains(got, "authorized..") {
				t.Fatalf("duplicated sentence terminator: %q", got)
			}
			want := "notice: showing active revision " + active + ". Could not read runtime status for newer revision " + newer + ": OCC operation failed (HTTP 403): FORBIDDEN: The runtime read is not authorized. To retry that revision, pass --revision " + newer + "."
			if got != want {
				t.Fatalf("notice = %q, want %q", got, want)
			}
			if !strings.Contains(output.String(), "ready") {
				t.Fatalf("active revision logs missing: %q", output.String())
			}
		})
	}
}
