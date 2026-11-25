package occcli

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGuardedAgentStopCLI(t *testing.T) {
	path := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/stop"
	accepted := `{"data":{"id":"` + testAgentID + `","namespaceId":"` + testNamespaceID + `","desiredRuntimeState":"stopped","activeRevisionId":"` + testRevision1ID + `"},"meta":{"requestId":"req_guarded_stop"}}`
	for _, test := range []struct {
		name, response, wantError string
		status                    int
	}{
		{"accepted", accepted, "", http.StatusAccepted},
		{"unexpected success status", accepted, "stop outcome is unknown", http.StatusOK},
		{"missing revision", strings.Replace(accepted, `,"activeRevisionId":"`+testRevision1ID+`"`, "", 1), "stop outcome is unknown", http.StatusAccepted},
		{"different revision", strings.Replace(accepted, testRevision1ID, testRevision2ID, 1), "stop outcome is unknown", http.StatusAccepted},
		{"older server", `{"error":{"code":"INVALID_REQUEST","message":"Invalid query parameters."}}`, "HTTP 400", http.StatusBadRequest},
		{"revision conflict", `{"error":{"code":"RESOURCE_CONFLICT","message":"Agent revision changed."}}`, "HTTP 409", http.StatusConflict},
		{"lost response", "", "OCC operation failed", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodPost || r.URL.RequestURI() != path+"?expectedActiveRevisionId="+testRevision1ID {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
				}
				if body, err := io.ReadAll(r.Body); err != nil || len(body) != 0 || r.Header.Get("Content-Type") != "" {
					t.Errorf("stop sent a body or Content-Type: body %q, error %v", body, err)
				}
				if test.status == 0 {
					conn, _, err := http.NewResponseController(w).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					conn.Close()
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.response)
			})
			out, notices, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", "stop", testAgentID, "--if-active-revision", testRevision1ID, "-o", "json")
			if got := requests.Load(); got != 1 {
				t.Errorf("got %d requests, want exactly one", got)
			}
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) || out != "" || strings.Contains(notices, "stop requested") {
					t.Fatalf("error = %v, stdout = %q, notices = %q; want %q without success", err, out, notices, test.wantError)
				}
				return
			}
			var stopped map[string]any
			if decodeErr := json.Unmarshal([]byte(out), &stopped); err != nil || decodeErr != nil || stopped["desiredRuntimeState"] != "stopped" || stopped["activeRevisionId"] != testRevision1ID || !strings.Contains(notices, "notice: stop requested;") {
				t.Fatalf("error = %v, JSON error = %v, stdout = %q, notices = %q", err, decodeErr, out, notices)
			}
		})
	}
	for _, test := range []struct{ revision, wantError string }{
		{"", "--if-active-revision must name a revision ID"},
		{"rev_invalid", "not a valid deployment ID"},
		{testAgentID, "deployment IDs start with"},
	} {
		t.Run("invalid "+test.revision, func(t *testing.T) {
			out, notices, err := runOCCWithArgs("--namespace", testNamespaceID, "--service-key-file", filepath.Join(t.TempDir(), "missing-key.json"), "agent", "stop", testAgentID, "--if-active-revision="+test.revision)
			if err == nil || !strings.Contains(err.Error(), test.wantError) || out != "" || strings.Contains(notices, "stop requested") {
				t.Fatalf("error = %v, stdout = %q, notices = %q; want %q before client construction", err, out, notices, test.wantError)
			}
		})
	}
}

func TestAgentStopReturnsNoticeDeliveryErrors(t *testing.T) {
	for _, state := range []string{"running", "idle", "stopping"} {
		t.Run(state, func(t *testing.T) {
			var requests []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests = append(requests, r.Method+" "+r.URL.Path)
				w.Header().Set("Content-Type", "application/json")
				agent := map[string]any{
					"id":                  testAgentID,
					"namespaceId":         testNamespaceID,
					"name":                "stop-output",
					"servicePrincipalId":  "sp-synthetic",
					"configurationId":     "cfg_00000000-0000-4000-8000-000000000001",
					"backendId":           nil,
					"harnessAuth":         nil,
					"executionMode":       "dedicated",
					"gatewayManagedMode":  true,
					"desiredRuntimeState": "stopped",
					"status":              "active",
					"createdAt":           "2026-11-14T00:00:00Z",
				}
				if state != "idle" {
					agent["activeRevisionId"] = testRevision1ID
				}
				if r.Method == http.MethodGet && state == "running" {
					agent["desiredRuntimeState"] = "running"
				}
				if r.Method == http.MethodPost {
					w.WriteHeader(http.StatusAccepted)
				}
				if err := json.MarshalWrite(w, map[string]any{"data": agent, "meta": map[string]any{"requestId": "req_stop_output"}}); err != nil {
					t.Error(err)
				}
			}))
			t.Cleanup(server.Close)
			keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
			deliveryErr := errors.New("notice destination unavailable")
			var out strings.Builder
			command := New(&out, &handoffFailingWriter{err: deliveryErr})
			command.SetArgs([]string{"agent", "stop", testAgentID, "--namespace", testNamespaceID, "--url", server.URL, "--service-key-file", keyFile, "-o", "json"})
			if err := command.Execute(); !errors.Is(err, deliveryErr) {
				t.Fatalf("error = %v, want notice delivery error", err)
			}
			// Delivery fails after admission and stdout; never retry the mutation.
			path := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
			if want := []string{"GET " + path, "POST " + path + "/stop"}; !slices.Equal(requests, want) {
				t.Fatalf("requests = %v, want %v", requests, want)
			}
			var agent map[string]any
			if err := json.Unmarshal([]byte(out.String()), &agent); err != nil || agent["id"] != testAgentID || agent["desiredRuntimeState"] != "stopped" {
				t.Fatalf("stdout = %q, error = %v", out.String(), err)
			}
			if state != "idle" && agent["activeRevisionId"] != testRevision1ID {
				t.Fatalf("stdout lost the active revision while stop is pending: %q", out.String())
			}
		})
	}
}
