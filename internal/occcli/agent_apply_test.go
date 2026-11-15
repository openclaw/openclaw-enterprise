package occcli

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

// An unknown name provisions the Agent. apply, not the file, supplies the request ID
// that provisioning needs to make a retry of the same request safe.
func TestAgentApplyProvisionsAnUnknownNameWithAValidRequestID(t *testing.T) {
	var provisioned map[string]any
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "GET /namespaces/" + testNamespaceID + "/agents":
			_, _ = writer.Write([]byte(`{"data":[{"id":"` + testAgentID + `","name":"other"}],"meta":{"requestId":"req_test"}}`))
		case "POST /namespaces/" + testNamespaceID + "/agents/provision":
			body, _ := io.ReadAll(request.Body)
			if err := json.Unmarshal(body, &provisioned); err != nil {
				t.Errorf("provision body %q: %v", body, err)
			}
			writer.WriteHeader(http.StatusAccepted)
			_, _ = writer.Write([]byte(`{"data":{"provisioning":{"workId":"work-1","agentId":"` + testAgentID + `","status":"queued"}},"meta":{"requestId":"req_test"}}`))
		default:
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
		}
	})
	file := t.TempDir() + "/agent.json"
	if err := os.WriteFile(file, []byte(`{"name":"new-agent","executionMode":"dedicated","configuration":{"kind":"agent","values":{}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	out, _, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", "apply", "--file", file, "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	requestID, _ := provisioned["requestId"].(string)
	if !occclient.IsTypedID(requestID, "req_") || provisioned["name"] != "new-agent" {
		t.Fatalf("provision body = %v, want name new-agent and a req_ UUID request ID", provisioned)
	}
	if !strings.Contains(out, `"result": "created"`) || !strings.Contains(out, `"workId": "work-1"`) {
		t.Fatalf("output = %s", out)
	}
}
