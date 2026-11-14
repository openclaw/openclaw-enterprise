package occcli

import (
	"encoding/json/v2"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

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
