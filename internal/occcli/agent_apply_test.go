package occcli

import (
	"cmp"
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

const applyConfigurationID = "cfg_33333333-3333-4333-8333-333333333333"

// applyServer serves one existing Agent and records every request. Its hooks
// replace the default replies for the Agent read and the deploy.
type applyServer struct {
	requests []string
	bodies   map[string]string
	// rebound is the Configuration the Agent reads as bound to.
	rebound string
	deploy  func(http.ResponseWriter)
	// secretBindings is the saved Configuration's JSON binding map.
	secretBindings string
	// agentPatchStatus replaces the Agent update's success reply when set.
	agentPatchStatus int
}

func (s *applyServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents"
	key := request.Method + " " + request.URL.Path
	body, _ := io.ReadAll(request.Body)
	if s.bodies == nil {
		s.bodies = map[string]string{}
	}
	s.bodies[key] = string(body)
	s.requests = append(s.requests, key)
	writer.Header().Set("content-type", "application/json")
	reply := func(status int, data string) {
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(`{"data":` + data + `,"meta":{"requestId":"req_test"}}`))
	}
	agent := func(configurationID string) string {
		return `{"id":"` + testAgentID + `","name":"existing","configurationId":"` + configurationID + `","executionMode":"dedicated"}`
	}
	switch key {
	case "GET " + agentPath:
		reply(200, `[`+agent(applyConfigurationID)+`]`)
	case "GET " + agentPath + "/" + testAgentID:
		configurationID := applyConfigurationID
		if s.rebound != "" {
			configurationID = s.rebound
		}
		reply(200, agent(configurationID))
	case "GET /namespaces/" + testNamespaceID + "/configurations/" + applyConfigurationID:
		bindings := cmp.Or(s.secretBindings, "{}")
		reply(200, `{"id":"`+applyConfigurationID+`","kind":"agent","generation":1,"values":{},"secretBindings":`+bindings+`}`)
	case "PATCH /namespaces/" + testNamespaceID + "/configurations/" + applyConfigurationID:
		reply(200, `{}`)
	case "PATCH " + agentPath + "/" + testAgentID:
		if s.agentPatchStatus != 0 {
			writer.WriteHeader(s.agentPatchStatus)
			_, _ = writer.Write([]byte(`{"error":{"code":"VALIDATION_FAILED","message":"no"},"meta":{"requestId":"req_test"}}`))
			return
		}
		reply(200, agent(applyConfigurationID))
	case "POST " + agentPath + "/" + testAgentID + "/deploy":
		if s.deploy != nil {
			s.deploy(writer)
			return
		}
		reply(202, `{"id":"rev_44444444-4444-4444-8444-444444444444"}`)
	default:
		writer.WriteHeader(http.StatusNotFound)
	}
}

func (s *applyServer) writes() []string {
	var writes []string
	for _, request := range s.requests {
		if !strings.HasPrefix(request, "GET ") {
			writes = append(writes, request)
		}
	}
	return writes
}

func applyFile(t *testing.T, document string) string {
	t.Helper()
	file := t.TempDir() + "/agent.json"
	if err := os.WriteFile(file, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func runApply(t *testing.T, server *applyServer, document string) (string, error) {
	t.Helper()
	_, errOut, err := runOCCAgainst(t, server, "--namespace", testNamespaceID, "agent", "apply", "--file", applyFile(t, document), "-o", "json")
	if err != nil {
		return err.Error() + errOut, err
	}
	return "", nil
}

const existingAgentFile = `{"name":"existing","executionMode":"dedicated","configuration":{"kind":"agent","values":{}}`

func TestAgentApplyRefusesAFileWithUnknownFieldsBeforeAnyWrite(t *testing.T) {
	for name, document := range map[string]string{
		"Agent field":         `{"name":"existing","harnessAut":null,"configuration":{"kind":"agent","values":{"a":1}}}`,
		"Configuration field": `{"name":"existing","configuration":{"kind":"agent","value":{},"values":{"a":1}}}`,
		"missing values":      `{"name":"existing","configuration":{"kind":"agent"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := &applyServer{}
			if message, err := runApply(t, server, document); err == nil {
				t.Fatal("apply accepted the file")
			} else if !strings.Contains(message, "unknown field") && !strings.Contains(message, "configuration.values") {
				t.Fatalf("message = %s", message)
			}
			if len(server.requests) != 0 {
				t.Fatalf("requests = %v, want none", server.requests)
			}
		})
	}
}

func TestAgentApplySavesAnExplicitEmptyApproverList(t *testing.T) {
	server := &applyServer{}
	if message, err := runApply(t, server, existingAgentFile+`,"pluginApprovers":[]}`); err != nil {
		t.Fatal(message)
	}
	agentPath := "PATCH /namespaces/" + testNamespaceID + "/agents/" + testAgentID
	if !strings.Contains(server.bodies[agentPath], `"pluginApprovers":[]`) {
		t.Fatalf("writes = %v, bodies = %v", server.writes(), server.bodies)
	}
}

func TestAgentApplyReusesTheRequestIDForTheSameFile(t *testing.T) {
	var ids []string
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		if request.Method == http.MethodGet {
			_, _ = writer.Write([]byte(`{"data":[],"meta":{"requestId":"req_test"}}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		ids = append(ids, body["requestId"].(string))
		writer.WriteHeader(http.StatusAccepted)
		_, _ = writer.Write([]byte(`{"data":{"provisioning":{"workId":"work-1","agentId":"` + testAgentID + `","status":"queued"}},"meta":{"requestId":"req_test"}}`))
	})
	for _, document := range []string{
		`{"name":"new-agent","executionMode":"dedicated","configuration":{"kind":"agent","values":{"a":1,"b":2}}}`,
		`{"configuration":{"values":{"b":2,"a":1},"kind":"agent"},"executionMode":"dedicated","name":"new-agent"}`,
		`{"name":"other-agent","executionMode":"dedicated","configuration":{"kind":"agent","values":{}}}`,
	} {
		if _, _, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", "apply", "--file", applyFile(t, document)); err != nil {
			t.Fatal(err)
		}
	}
	if ids[0] != ids[1] || ids[0] == ids[2] || !occclient.IsTypedID(ids[0], "req_") {
		t.Fatalf("request IDs = %v, want equal for the same file, distinct for another, and valid", ids)
	}
}

func TestAgentApplyStopsWhenTheAgentIsRebound(t *testing.T) {
	server := &applyServer{rebound: "cfg_55555555-5555-4555-8555-555555555555"}
	message, err := runApply(t, server, existingAgentFile+`,"backendId":"other"}`)
	if err == nil || !strings.Contains(message, "bound to another Configuration") {
		t.Fatalf("message = %q, err = %v", message, err)
	}
	if writes := server.writes(); len(writes) != 0 {
		t.Fatalf("writes = %v, want none", writes)
	}
}

func TestAgentApplyDeployAdviceDependsOnWhetherOCCRefused(t *testing.T) {
	changed := `{"name":"existing","configuration":{"kind":"agent","values":{"a":1}}}`
	for name, deploy := range map[string]func(http.ResponseWriter){
		"lost reply": func(writer http.ResponseWriter) {
			connection, _, _ := writer.(http.Hijacker).Hijack()
			_ = connection.Close()
		},
		"5xx reply":     func(writer http.ResponseWriter) { writer.WriteHeader(http.StatusBadGateway) },
		"timeout reply": func(writer http.ResponseWriter) { writer.WriteHeader(http.StatusRequestTimeout) },
	} {
		message, err := runApply(t, &applyServer{deploy: deploy}, changed)
		if err == nil || !strings.Contains(message, "deploy result is unknown") || !strings.Contains(message, "Agent settings") || strings.Contains(message, "agent deploy") {
			t.Fatalf("%s: message = %q, err = %v", name, message, err)
		}
	}
	refused := &applyServer{deploy: func(writer http.ResponseWriter) {
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"error":{"code":"CONFLICT","message":"no"},"meta":{"requestId":"req_test"}}`))
	}}
	want := "--namespace " + testNamespaceID + " agent deploy " + testAgentID
	if message, err := runApply(t, refused, changed); err == nil || !strings.Contains(message, `run "occ --url `) || !strings.Contains(message, want) {
		t.Fatalf("refusal: message = %q, err = %v", message, err)
	}
}

func TestAgentApplyTreatsAnOmittedSecretDeliveryAsTheSavedDefault(t *testing.T) {
	source := `{"kind":"secret","namespaceId":"` + testNamespaceID + `","id":"sec_66666666-6666-4666-8666-666666666666"}`
	saved := `{"SLACK_BOT_TOKEN":{"source":` + source + `,"delivery":{"type":"env"}}}`
	server := &applyServer{secretBindings: saved}
	document := `{"name":"existing","configuration":{"kind":"agent","values":{},"secretBindings":{"SLACK_BOT_TOKEN":{"source":` + source + `}}}}`
	if message, err := runApply(t, server, document); err != nil {
		t.Fatal(message)
	}
	if writes := server.writes(); len(writes) != 0 {
		t.Fatalf("writes = %v, want none", writes)
	}
}

func TestAgentApplyPartialSaveNamesTheDeployCommand(t *testing.T) {
	server := &applyServer{agentPatchStatus: http.StatusUnprocessableEntity}
	message, err := runApply(t, server, `{"name":"existing","executionMode":"dedicatd","configuration":{"kind":"agent","values":{"a":1}}}`)
	want := "--namespace " + testNamespaceID + " agent deploy " + testAgentID
	if err == nil || !strings.Contains(message, "saved the Configuration but not the Agent fields") || !strings.Contains(message, want) {
		t.Fatalf("message = %q, err = %v", message, err)
	}
}
