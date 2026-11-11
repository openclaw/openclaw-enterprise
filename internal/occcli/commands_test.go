package occcli

import (
	"bytes"
	"encoding/json/v2"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"go.yaml.in/yaml/v3"
)

const (
	testNamespaceID = "ns_11111111-1111-4111-8111-111111111111"
	testAgentID     = "agt_22222222-2222-4222-8222-222222222222"
	testRevision1ID = "rev_33333333-3333-4333-8333-333333333333"
	testRevision2ID = "rev_44444444-4444-4444-8444-444444444444"
)

type fakeOCC struct {
	mu        sync.Mutex
	responses map[string]string
	requested []string
	// refuse, when set, answers every request 403 FORBIDDEN with this message.
	refuse string
}

func (fake *fakeOCC) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	key := request.Method + " " + request.URL.Path
	requested := key
	if request.URL.RawQuery != "" {
		// Responses are keyed by path; the record keeps the query so tests can assert it.
		requested += "?" + request.URL.RawQuery
	}
	fake.mu.Lock()
	fake.requested = append(fake.requested, requested)
	fake.mu.Unlock()
	if fake.refuse != "" {
		writer.WriteHeader(http.StatusForbidden)
		_ = json.MarshalWrite(writer, map[string]any{"error": map[string]string{"code": "FORBIDDEN", "message": fake.refuse}})
		return
	}
	data, ok := fake.responses[key]
	if !ok {
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"not found"}}`))
		return
	}
	if raw, ok := strings.CutPrefix(data, "raw:"); ok {
		// "raw:<status> <body>" answers with that status and body, unwrapped.
		status, _ := strconv.Atoi(raw[:3])
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(raw[4:]))
		return
	}
	if data == "" {
		// An empty response stands for a bodyless 204, as OCC answers a delete.
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	writer.Header().Set("content-type", "application/json")
	_, _ = writer.Write([]byte(`{"data":` + data + `,"meta":{"requestId":"req_test"}}`))
}

func runOCC(t *testing.T, responses map[string]string, args ...string) (string, []string, error) {
	t.Helper()
	out, _, requested, err := runOCCWithNotices(t, responses, args...)
	return out, requested, err
}

// runOCCWithNotices returns stdout, stderr, and the request trace.
func runOCCWithNotices(t *testing.T, responses map[string]string, args ...string) (string, string, []string, error) {
	t.Helper()
	fake := &fakeOCC{responses: responses}
	out, errOut, err := runOCCAgainst(t, fake, args...)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return out, errOut, append([]string(nil), fake.requested...), err
}

// runOCCAgainst runs occ against handler and returns stdout, stderr, and the error.
func runOCCAgainst(t *testing.T, handler http.Handler, args ...string) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()
	keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
	return runOCCWithArgs(append([]string{"--url", server.URL, "--service-key-file", keyFile}, args...)...)
}

// runOCCWithArgs executes exactly the supplied arguments, using the current environment.
func runOCCWithArgs(args ...string) (string, string, error) {
	var out, errOut bytes.Buffer
	command := New(&out, &errOut)
	command.SetArgs(args)
	err := command.Execute()
	return out.String(), errOut.String(), err
}

func TestAgentStopRejectsAnAcceptedResponseWithoutTheStoppedAgent(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	wantRequests := []string{"GET " + agentPath, "POST " + agentPath + "/stop"}
	for _, test := range []struct {
		name string
		data string
	}{
		{"null Agent", "null"},
		{"empty Agent", "{}"},
		{"missing desired state", `{"id":"` + testAgentID + `","namespaceId":"` + testNamespaceID + `"}`},
		{"different Agent", `{"id":"agt_00000000-0000-4000-8000-000000000001","namespaceId":"` + testNamespaceID + `","desiredRuntimeState":"stopped"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, errOut, requested, err := runOCCWithNotices(t, map[string]string{
				wantRequests[0]: `{"id":"` + testAgentID + `","namespaceId":"` + testNamespaceID + `","desiredRuntimeState":"running"}`,
				wantRequests[1]: `raw:202 {"data":` + test.data + `,"meta":{"requestId":"req_00000000-0000-4000-8000-000000000001"}}`,
			}, "--namespace", testNamespaceID, "agent", "stop", testAgentID, "-o", "json")
			if !slices.Equal(requested, wantRequests) {
				t.Fatalf("requests = %v, want %v", requested, wantRequests)
			}
			wantHint := `occ --namespace ` + testNamespaceID + ` agent get ` + testAgentID
			if err == nil || !strings.Contains(err.Error(), "stop outcome is unknown") || !strings.Contains(err.Error(), wantHint) {
				t.Errorf("stop error = %v, want an unknown outcome and %q", err, wantHint)
			}
			if out != "" || strings.Contains(errOut, "stop requested") {
				t.Errorf("stdout = %q, stderr = %q, want no success output", out, errOut)
			}
		})
	}
}

func TestNamespaceTableLabelsTheAdoptedNamespaceColumn(t *testing.T) {
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces": `[{"id":"` + testNamespaceID + `","name":"team","status":"ready","createdAt":"2026-09-30T00:00:00.000Z"}]`,
	}, "namespace", "list")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "KUBERNETES NAMESPACE") || !strings.Contains(out, "ADOPTED NAMESPACE") {
		t.Fatalf("managed Namespaces must not read as having no Kubernetes namespace:\n%s", out)
	}
}

func TestAgentTableLabelsLifecycleSeparatelyFromDeploymentHealth(t *testing.T) {
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID: `{"id":"` + testAgentID + `","name":"a","status":"active","desiredRuntimeState":"running"}`,
	}, "--namespace", testNamespaceID, "agent", "get", testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	header := strings.SplitN(out, "\n", 2)[0]
	if strings.Contains(header, " STATUS") || !strings.Contains(header, "LIFECYCLE") {
		t.Fatalf("Agent lifecycle must not be labeled STATUS:\n%s", out)
	}
}

// OCC does not restart a lost Harness Sandbox (finding 2152), so the Agent's lifecycle alone
// reads active while nothing serves it. `agent get` follows the table with the Sandbox's
// observed state and the next step; a status OCC cannot read is unknown, never lost.
func TestAgentGetShowsTheObservedHarnessSandbox(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	agent := `{"id":"` + testAgentID + `","name":"a","status":"active","desiredRuntimeState":"running","activeRevisionId":"` + testRevision1ID + `"}`
	observed := func(harness string) string {
		return `{"status":"observed","revisionId":"` + testRevision1ID + `","harness":` + harness + `}`
	}
	for _, test := range []struct {
		name, status, want string
	}{
		{"lost", observed(`{"state":"lost","code":"SANDBOX_STOPPED"}`), "Harness Sandbox: lost (SANDBOX_STOPPED). OCC will not restart it; deploy the Agent again to replace it."},
		{"healthy", observed(`{"state":"running"}`), "Harness Sandbox: running"},
		{"observation failed", observed(`{"state":"unknown","code":"UNAVAILABLE"}`), "Harness Sandbox: unknown (UNAVAILABLE)"},
		{"read failed", `raw:503 {"error":{"code":"DEPENDENCY_UNAVAILABLE","message":"unavailable"}}`, "Harness Sandbox: unknown (the status could not be read)."},
		// The logs hint names the observed revision, so a later deployment cannot redirect it.
		{"restarting", observed(`{"state":"starting","code":"HARNESS_RESTARTING","exitCode":1,"restarts":2}`), "Harness Sandbox: starting (HARNESS_RESTARTING, last exit code 1, restart 2). The Harness process exited and OpenShell is restarting it; if this persists, read its Sandbox logs (occ --namespace " + testNamespaceID + " agent logs " + testAgentID + " --source sandbox --revision " + testRevision1ID + ")."},
		// A revision ID OCC would not issue is not echoed into the logs hint.
		{"odd revision", `{"status":"observed","revisionId":"rev_00000000-0000-4000-8000-000000000001 --source gateway","harness":{"state":"starting","code":"HARNESS_RESTARTING","exitCode":1,"restarts":2}}`, "Harness Sandbox: starting (HARNESS_RESTARTING, last exit code 1, restart 2). The Harness process exited and OpenShell is restarting it; if this persists, read its Sandbox logs (occ --namespace " + testNamespaceID + " agent logs " + testAgentID + " --source sandbox)."},
		// A stopped Agent, an embedded Harness or a Driver without a Sandbox record adds nothing.
		{"unobserved", `{"status":"unobserved"}`, ""},
	} {
		responses := map[string]string{"GET " + agentPath: agent, "GET " + agentPath + "/harness-status": test.status}
		out, requested, err := runOCC(t, responses, "--namespace", testNamespaceID, "agent", "get", testAgentID)
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		table, line, _ := strings.Cut(out, "\n\n")
		if !strings.Contains(table, testAgentID) || strings.TrimSuffix(line, "\n") != test.want {
			t.Errorf("%s: agent get printed:\n%s", test.name, out)
		}
		if !slices.Equal(requested, []string{"GET " + agentPath, "GET " + agentPath + "/harness-status"}) {
			t.Errorf("%s: requests = %q", test.name, requested)
		}
		if test.name == "healthy" && strings.Contains(out, "deploy") {
			t.Errorf("a healthy Harness Sandbox must carry no warning:\n%s", out)
		}
	}
	// Structured output is the Agent resource alone, and a stopped Agent has no Sandbox to
	// read, so neither reads the status.
	for _, test := range []struct {
		name, agent string
		args        []string
	}{
		{"json", agent, []string{"-o", "json"}},
		{"stopped", strings.Replace(agent, `"running"`, `"stopped"`, 1), nil},
		{"deleting", strings.Replace(agent, `"active"`, `"deleting"`, 1), nil},
		{"no active revision", strings.Replace(agent, testRevision1ID, "", 1), nil},
	} {
		args := append(append([]string{"--namespace", testNamespaceID}, test.args...), "agent", "get", testAgentID)
		out, requested, err := runOCC(t, map[string]string{"GET " + agentPath: test.agent}, args...)
		if err != nil || strings.Contains(out, "Harness") || len(requested) != 1 {
			t.Fatalf("%s: err = %v, requests = %q:\n%s", test.name, err, requested, out)
		}
	}
}

func TestResourceCommandsRejectNamesWithAHintBeforeCallingOCC(t *testing.T) {
	inNamespace := "occ --namespace " + testNamespaceID
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--namespace", testNamespaceID, "agent", "get", "dogfood-agent"}, nameNotIDRefusal("dogfood-agent", "Agent", "agt_", inNamespace+" agent list")},
		{[]string{"--namespace", "default", "agent", "list"}, "OCC_NAMESPACE or --namespace: " + nameNotIDRefusal("default", "Namespace", "ns_", "occ namespace list")},
		{[]string{"namespace", "get", "default"}, nameNotIDRefusal("default", "Namespace", "ns_", "occ namespace list")},
		{[]string{"--namespace", testNamespaceID, "secret", "get", "model-key"}, nameNotIDRefusal("model-key", "Secret", "sec_", inNamespace+" secret list")},
		{[]string{"--namespace", testNamespaceID, "preset", "delete", "default-codex"}, nameNotIDRefusal("default-codex", "Preset", "pre_", inNamespace+" preset list")},
		{[]string{"--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, "1"}, nameNotIDRefusal("1", "deployment", "rev_", inNamespace+" agent revisions AGENT_ID")},
		{[]string{"--namespace", testNamespaceID, "credential-source", "update", "openai"}, nameNotIDRefusal("openai", "credential source", "cs_", inNamespace+" credential-source list")},
		{[]string{"--namespace", testNamespaceID, "service-account", "delete", "--force", "ci-bot"}, nameNotIDRefusal("ci-bot", "ServiceAccount", "sa_", inNamespace+" service-account list")},
		{[]string{"--namespace", testNamespaceID, "agent", "credential-withdrawal", "request", "dogfood-agent", "cs_00000000-0000-4000-8000-000000000001"}, nameNotIDRefusal("dogfood-agent", "Agent", "agt_", inNamespace+" agent list")},
		{[]string{"--namespace", testNamespaceID, "agent", "credential-withdrawal", "get", testAgentID, "openai"}, nameNotIDRefusal("openai", "credential source", "cs_", inNamespace+" credential-source list")},
	}
	for _, testCase := range cases {
		_, requested, err := runOCC(t, map[string]string{}, testCase.args...)
		if err == nil || err.Error() != testCase.want {
			t.Errorf("%v: error = %v, want %q", testCase.args, err, testCase.want)
		}
		if len(requested) != 0 {
			t.Errorf("%v: expected no request, got %v", testCase.args, requested)
		}
	}
}

func TestIDHintsKeepTheSelectedNamespace(t *testing.T) {
	// A stale environment scope must not replace the explicitly selected Namespace in the hint.
	t.Setenv("OCC_NAMESPACE", "ns_55555555-5555-4555-8555-555555555555")
	inNamespace := "occ --namespace " + testNamespaceID
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--namespace", testNamespaceID, "agent", "get", "dogfood-agent"}, nameNotIDRefusal("dogfood-agent", "Agent", "agt_", inNamespace+" agent list")},
		{[]string{"--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, "1"}, nameNotIDRefusal("1", "deployment", "rev_", inNamespace+" agent revisions AGENT_ID")},
		{[]string{"--namespace", testNamespaceID, "agent", "logs", testAgentID, "--source", "gateway", "--revision", "1"}, nameNotIDRefusal("1", "deployment", "rev_", inNamespace+" agent revisions AGENT_ID")},
		{[]string{"--namespace", testNamespaceID, "configuration", "get", "base"}, nameNotIDRefusal("base", "Configuration", "cfg_", inNamespace+" agent get AGENT_ID")},
		{[]string{"--namespace", testNamespaceID, "secret", "get", "model-key"}, nameNotIDRefusal("model-key", "Secret", "sec_", inNamespace+" secret list")},
		// Namespaces are not Namespace-scoped, and a selection that is not a
		// Namespace ID is left out rather than repeated into the hint.
		{[]string{"--namespace", testNamespaceID, "namespace", "get", "default"}, nameNotIDRefusal("default", "Namespace", "ns_", "occ namespace list")},
		{[]string{"--namespace", "default", "agent", "get", "dogfood-agent"}, nameNotIDRefusal("dogfood-agent", "Agent", "agt_", "occ agent list")},
	}
	for _, testCase := range cases {
		_, requested, err := runOCC(t, map[string]string{}, testCase.args...)
		if err == nil || err.Error() != testCase.want {
			t.Errorf("%v: error = %v, want %q", testCase.args, err, testCase.want)
		}
		if len(requested) != 0 {
			t.Errorf("%v: expected no request, got %v", testCase.args, requested)
		}
	}
}

func TestIDHintsNameTheEnvironmentNamespaceWhenNoFlagIsPassed(t *testing.T) {
	t.Setenv("OCC_NAMESPACE", testNamespaceID)
	_, requested, err := runOCC(t, map[string]string{}, "agent", "get", "dogfood-agent")
	if want := nameNotIDRefusal("dogfood-agent", "Agent", "agt_", "occ --namespace "+testNamespaceID+" agent list"); err == nil || err.Error() != want {
		t.Errorf("error = %v, want %q", err, want)
	}
	if len(requested) != 0 {
		t.Errorf("expected no request, got %v", requested)
	}
}

// Finding D744: a value with the right prefix but not the API's ID shape is
// refused before any request; "agt_../../namespaces" used to reach a gateway that
// normalized it into another path and answered 307, which occ blamed on OCC_URL.
func TestMalformedIDsAreRefusedBeforeAnyRequest(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"agent", "get", "agt_../../namespaces"}, malformedIDRefusal("agt_../../namespaces", "Agent", "agt_")},
		{[]string{"agent", "get", "agt_.."}, malformedIDRefusal("agt_..", "Agent", "agt_")},
		{[]string{"agent", "get", testAgentID + "/"}, malformedIDRefusal(testAgentID+"/", "Agent", "agt_")},
		{[]string{"agent", "get", "agt_%2e%2e%2fnamespaces"}, malformedIDRefusal("agt_%2e%2e%2fnamespaces", "Agent", "agt_")},
		{[]string{"agent", "get", "AGT_22222222-2222-4222-8222-222222222222"}, malformedIDRefusal("AGT_22222222-2222-4222-8222-222222222222", "Agent", "agt_")},
		{[]string{"agent", "get", "agt_"}, malformedIDRefusal("agt_", "Agent", "agt_")},
		{[]string{"agent", "get", "agt_22222222-2222-4222-8222-22222222222Z"}, malformedIDRefusal("agt_22222222-2222-4222-8222-22222222222Z", "Agent", "agt_")},
		{[]string{"secret", "get", "sec_x\x00"}, malformedIDRefusal("sec_x\x00", "Secret", "sec_")},
		{[]string{"agent", "deployment-status", testAgentID, "rev_../1"}, malformedIDRefusal("rev_../1", "deployment", "rev_")},
		{[]string{"agent", "logs", testAgentID, "--source", "gateway", "--revision", "rev_1/"}, malformedIDRefusal("rev_1/", "deployment", "rev_")},
		{[]string{"iam", "role", "get", "../roles"}, opaqueIDRefusal("../roles", "Role")},
		{[]string{"iam", "access-binding", "delete", ".."}, opaqueIDRefusal("..", "AccessBinding")},
		{[]string{"iam", "service-principal", "get", "a/b"}, opaqueIDRefusal("a/b", "ServicePrincipal")},
	}
	for _, testCase := range cases {
		_, requested, err := runOCC(t, map[string]string{}, append([]string{"--namespace", testNamespaceID}, testCase.args...)...)
		if err == nil || err.Error() != testCase.want {
			t.Errorf("%v: error = %v, want %q", testCase.args, err, testCase.want)
		}
		if len(requested) != 0 {
			t.Errorf("%v: expected no request, got %v", testCase.args, requested)
		}
	}
	// A malformed selected Namespace is refused the same way, and never echoed into a lookup hint.
	_, requested, err := runOCC(t, map[string]string{}, "--namespace", "ns_../..", "agent", "list")
	if want := "OCC_NAMESPACE or --namespace: " + malformedIDRefusal("ns_../..", "Namespace", "ns_"); err == nil || err.Error() != want {
		t.Errorf("error = %v, want %q", err, want)
	}
	if len(requested) != 0 {
		t.Errorf("expected no request, got %v", requested)
	}
}

func TestWellFormedIDsAreStillSent(t *testing.T) {
	agentPath := "GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID
	out, requested, err := runOCC(t, map[string]string{
		agentPath: `{"id":"` + testAgentID + `","name":"a","status":"active","desiredRuntimeState":"running"}`,
	}, "--namespace", testNamespaceID, "agent", "get", testAgentID)
	if err != nil || !strings.Contains(out, testAgentID) || !slices.Equal(requested, []string{agentPath}) {
		t.Fatalf("agent get: err=%v requested=%v out=%s", err, requested, out)
	}
	// An opaque ID may hold dots, as long as it is not only dots.
	rolePath := "GET /namespaces/" + testNamespaceID + "/iam/roles/role_custom.v2"
	_, requested, err = runOCC(t, map[string]string{
		rolePath: `{"id":"role_custom.v2","namespaceId":"` + testNamespaceID + `","permissions":[{"action":"read","resourceKind":"agent"}]}`,
	}, "--namespace", testNamespaceID, "iam", "role", "get", "role_custom.v2")
	if err != nil || !slices.Equal(requested, []string{rolePath}) {
		t.Fatalf("role get: err=%v requested=%v", err, requested)
	}
}

func TestSecretListShowsNamespaceSecrets(t *testing.T) {
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/secrets": `[{"id":"sec_55555555-5555-4555-8555-555555555555","name":"model-key","namespaceId":"` + testNamespaceID + `","ref":{}}]`,
	}, "--namespace", testNamespaceID, "secret", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "model-key") {
		t.Fatalf("expected the Secret in the list:\n%s", out)
	}
}

func TestSecretGetTableNamesConsumersAndCountsUnreadableOnes(t *testing.T) {
	const secretID = "sec_55555555-5555-4555-8555-555555555555"
	const configurationID = "cfg_77777777-7777-4777-8777-777777777777"
	secret := `{"id":"` + secretID + `","name":"model-key","namespaceId":"` + testNamespaceID + `","ref":{},` +
		`"consumers":{"agents":["` + testAgentID + `"],"configurations":["` + configurationID + `"],` +
		`"credentialSources":[],"provisioningRequests":[],"unreadable":2,"truncated":true}}`
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/secrets/" + secretID: secret,
	}, "--namespace", testNamespaceID, "secret", "get", secretID)
	if err != nil {
		t.Fatal(err)
	}
	want := "agent:" + testAgentID + ", configuration:" + configurationID + ", 2 unreadable, more"
	if !strings.Contains(out, "CONSUMERS") || !strings.Contains(out, want) {
		t.Fatalf("expected the consumers column %q:\n%s", want, out)
	}

	unused := `{"id":"` + secretID + `","name":"model-key","namespaceId":"` + testNamespaceID + `","ref":{},` +
		`"consumers":{"agents":[],"configurations":[],"credentialSources":[],"provisioningRequests":[],"unreadable":0,"truncated":false}}`
	out, _, err = runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/secrets/" + secretID: unused,
	}, "--namespace", testNamespaceID, "secret", "get", secretID)
	if err != nil {
		t.Fatal(err)
	}
	if row := strings.Fields(strings.Split(out, "\n")[1]); len(row) != 3 || row[2] != "-" {
		t.Fatalf("an unreferenced Secret must show no consumers:\n%s", out)
	}
}

func TestPresetCommandsListShowAndDeleteNamespacePresets(t *testing.T) {
	const presetID = "pre_66666666-6666-4666-8666-666666666666"
	collection := "/namespaces/" + testNamespaceID + "/presets"
	preset := `{"id":"` + presetID + `","namespaceId":"` + testNamespaceID + `","name":"default-codex",` +
		`"template":{"agent":{"name":"{{ vars.name }}"}},"createdAt":"2026-09-30T00:00:00.000Z"}`
	responses := map[string]string{
		"GET " + collection:                     "[" + preset + "]",
		"GET " + collection + "/" + presetID:    preset,
		"DELETE " + collection + "/" + presetID: "",
	}

	out, requested, err := runOCC(t, responses, "--namespace", testNamespaceID, "preset", "list")
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || !slices.Equal(strings.Fields(lines[0]), []string{"ID", "NAME", "CREATED"}) ||
		!slices.Equal(strings.Fields(lines[1]), []string{presetID, "default-codex", "2026-09-30T00:00:00.000Z"}) {
		t.Fatalf("unexpected Preset table:\n%s", out)
	}

	// Structured output is the whole Preset, template included.
	out, _, err = runOCC(t, responses, "--namespace", testNamespaceID, "-o", "json", "preset", "get", presetID)
	if err != nil {
		t.Fatal(err)
	}
	var shown map[string]any
	if err := json.Unmarshal([]byte(out), &shown); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if template, _ := shown["template"].(map[string]any); shown["id"] != presetID || template["agent"] == nil {
		t.Fatalf("expected the Preset with its template, got %v", shown)
	}

	out, requested, err = runOCC(t, responses, "--namespace", testNamespaceID, "preset", "delete", presetID)
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
	}
	if out != "Deleted preset "+presetID+".\n" || !slices.Equal(requested, []string{"DELETE " + collection + "/" + presetID}) {
		t.Fatalf("delete printed %q after %v", out, requested)
	}
}

func TestServiceAccountDeleteForceReportsTheUnrevokedToken(t *testing.T) {
	const accountID = "sa_66666666-6666-4666-8666-666666666666"
	path := "/namespaces/" + testNamespaceID + "/service-accounts/" + accountID

	// Without --force the CLI sends no query and prints the ordinary deletion.
	out, requested, err := runOCC(t, map[string]string{"DELETE " + path: ""},
		"--namespace", testNamespaceID, "service-account", "delete", accountID)
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
	}
	if out != "Deleted service account "+accountID+".\n" || !slices.Equal(requested, []string{"DELETE " + path}) {
		t.Fatalf("delete printed %q after %v", out, requested)
	}

	// --force where a Backend revoked the token as usual: OCC answers 204, same output.
	out, requested, err = runOCC(t, map[string]string{"DELETE " + path: ""},
		"--namespace", testNamespaceID, "service-account", "delete", "--force", accountID)
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
	}
	if out != "Deleted service account "+accountID+".\n" || !slices.Equal(requested, []string{"DELETE " + path + "?force=true"}) {
		t.Fatalf("forced delete printed %q after %v", out, requested)
	}

	// --force with no Backend to revoke the token: OCC reports it, and the CLI warns.
	unrevoked := map[string]string{
		"DELETE " + path: `{"id":"` + accountID + `","namespaceId":"` + testNamespaceID + `","revocation":"skipped","backendId":"chatgpt"}`,
	}
	out, warnings, _, err := runOCCWithNotices(t, unrevoked,
		"--namespace", testNamespaceID, "service-account", "delete", "--force", accountID)
	if err != nil {
		t.Fatal(err)
	}
	if out != "Deleted service account "+accountID+"; its access token was not revoked.\n" {
		t.Fatalf("unexpected table output %q", out)
	}
	if !strings.Contains(warnings, "revoke it at the provider") ||
		!strings.Contains(warnings, `ChatGPT Backend "chatgpt"`) {
		t.Fatalf("expected a revocation warning, got %q", warnings)
	}

	out, _, err = runOCC(t, unrevoked,
		"--namespace", testNamespaceID, "-o", "json", "service-account", "delete", "--force", accountID)
	if err != nil {
		t.Fatal(err)
	}
	var shown map[string]any
	if err := json.Unmarshal([]byte(out), &shown); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if shown["deleted"] != true || shown["id"] != accountID || shown["revocation"] != "skipped" || shown["backendId"] != "chatgpt" {
		t.Fatalf("unexpected structured output %v", shown)
	}

	// A refusal stays an error: --force never hides one.
	_, _, err = runOCC(t, map[string]string{},
		"--namespace", testNamespaceID, "service-account", "delete", "--force", accountID)
	if err == nil {
		t.Fatal("expected the API refusal to fail the command")
	}
}

func TestServiceAccountForceDeleteRejectsAMalformedSuccess(t *testing.T) {
	const accountID = "sa_66666666-6666-4666-8666-666666666666"
	keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
	// A forced delete succeeds only with a bodyless 204 or a full 200 envelope.
	for _, test := range []struct {
		respond func(http.ResponseWriter)
		message string
	}{
		{func(writer http.ResponseWriter) {
			writer.Header().Set("content-type", "application/json")
			_, _ = writer.Write([]byte(`{"data":{"revocation":"skipped"}}`))
		}, "OCC returned an invalid response (HTTP 200)"},
		{func(writer http.ResponseWriter) {
			writer.WriteHeader(http.StatusAccepted)
		}, "OCC returned an unexpected response (HTTP 202)"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.Method != http.MethodDelete || request.URL.RawQuery != "force=true" {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			test.respond(writer)
		}))
		command := New(&bytes.Buffer{}, &bytes.Buffer{})
		command.SetArgs([]string{"--url", server.URL, "--service-key-file", keyFile,
			"--namespace", testNamespaceID, "service-account", "delete", "--force", accountID})
		err := command.Execute()
		server.Close()
		if err == nil || err.Error() != test.message {
			t.Fatalf("expected %q, got %v", test.message, err)
		}
	}
}

func TestServiceAccountListShowsNamespaceAccounts(t *testing.T) {
	const accountID = "sa_66666666-6666-4666-8666-666666666666"
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/service-accounts": `[{"id":"` + accountID + `","namespaceId":"` + testNamespaceID + `","name":"ci-bot"}]`,
	}, "--namespace", testNamespaceID, "service-account", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, accountID) || !strings.Contains(out, "ci-bot") {
		t.Fatalf("expected the account in the list:\n%s", out)
	}
}

// agentRevisionsResponse is a revision list as OCC answers it: summaries that
// carry each revision's deployment status and error code.
func agentRevisionsResponse() string {
	return `[{"id":"` + testRevision2ID + `","revision":2,"agentId":"` + testAgentID + `","configurationGeneration":2,"createdAt":"2026-09-30T01:00:00.000Z","deploymentStatus":"failed","deploymentErrorCode":"CONVERGENCE_DEADLINE_EXCEEDED"},` +
		`{"id":"` + testRevision1ID + `","revision":1,"agentId":"` + testAgentID + `","configurationGeneration":1,"createdAt":"2026-09-30T00:00:00.000Z","deploymentStatus":"succeeded","deploymentErrorCode":null}]`
}

// agentRevisionResponses serves an Agent whose active revision is revision 1,
// a failed revision 2, and the revision list.
func agentRevisionResponses() map[string]string {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	return map[string]string{
		"GET " + agentPath:                `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision1ID + `"}`,
		"GET " + agentPath + "/revisions": agentRevisionsResponse(),
	}
}

func TestAgentRevisionsTellsRevisionsApart(t *testing.T) {
	out, requested, err := runOCC(t, agentRevisionResponses(), "--namespace", testNamespaceID, "agent", "revisions", testAgentID)
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected a header and two rows:\n%s", out)
	}
	if fields := strings.Fields(lines[0]); !slices.Equal(fields, []string{"ACTIVE", "ID", "REVISION", "GENERATION", "STATUS", "CONFIGURATION", "CREATED"}) {
		t.Fatalf("unexpected header %q", lines[0])
	}
	if fields := strings.Fields(lines[1]); !slices.Equal(fields, []string{testRevision2ID, "2", "2", "failed", "-", "2026-09-30T01:00:00.000Z"}) {
		t.Fatalf("revision 2 must be inactive, generation 2, failed: %q", lines[1])
	}
	if fields := strings.Fields(lines[2]); !slices.Equal(fields, []string{"*", testRevision1ID, "1", "1", "succeeded", "-", "2026-09-30T00:00:00.000Z"}) {
		t.Fatalf("revision 1 must be active, generation 1, succeeded: %q", lines[2])
	}
}

func TestAgentRevisionReadsExactSnapshotWithoutListing(t *testing.T) {
	path := "GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/revisions/" + testRevision1ID
	snapshot := `{"id":"` + testRevision1ID + `","namespaceId":"` + testNamespaceID + `","agentId":"` + testAgentID + `","harness":{"id":"codex","version":"1","mode":"dedicated","overrides":{},"configuration":{}}}`
	out, requested, err := runOCC(t, map[string]string{path: snapshot}, "--namespace", testNamespaceID, "-o", "json", "agent", "revision", testAgentID, testRevision1ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(requested, []string{path}) {
		t.Fatalf("exact revision read must not select from history: %v", requested)
	}
	var got, want any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(snapshot), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot changed: %s", out)
	}
	denied := &fakeOCC{refuse: "revision read denied"}
	out, _, err = runOCCAgainst(t, denied, "--namespace", testNamespaceID, "-o", "json", "agent", "revision", testAgentID, testRevision1ID)
	if err == nil || out != "" || !slices.Equal(denied.requested, []string{path}) {
		t.Fatalf("refused exact read must not fall back: output=%q requests=%v error=%v", out, denied.requested, err)
	}
}

func TestAgentRevisionsStructuredOutputCarriesActiveAndStatus(t *testing.T) {
	for _, format := range []string{"json", "yaml"} {
		out, _, err := runOCC(t, agentRevisionResponses(), "--namespace", testNamespaceID, "-o", format, "agent", "revisions", testAgentID)
		if err != nil {
			t.Fatal(err)
		}
		var rows []map[string]any
		if format == "json" {
			err = json.Unmarshal([]byte(out), &rows)
		} else {
			err = yaml.Unmarshal([]byte(out), &rows)
		}
		if err != nil {
			t.Fatalf("%s: %v\n%s", format, err, out)
		}
		if len(rows) != 2 {
			t.Fatalf("%s: expected two revisions:\n%s", format, out)
		}
		if rows[0]["active"] != false || rows[0]["deploymentStatus"] != "failed" || rows[0]["deploymentErrorCode"] != "CONVERGENCE_DEADLINE_EXCEEDED" {
			t.Fatalf("%s: revision 2 = %v", format, rows[0])
		}
		if rows[1]["active"] != true || rows[1]["deploymentStatus"] != "succeeded" {
			t.Fatalf("%s: revision 1 = %v", format, rows[1])
		}
	}
}

func TestDeploymentStatusDefaultsToTheLatestRevision(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	out, requested, err := runOCC(t, map[string]string{
		"GET " + agentPath:                `{"id":"` + testAgentID + `","desiredRuntimeState":"running","activeRevisionId":"` + testRevision2ID + `"}`,
		"GET " + agentPath + "/revisions": agentRevisionsResponse(),
		"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","agentId":"` + testAgentID +
			`","namespaceId":"` + testNamespaceID + `","status":"failed","error":{"code":"CONVERGENCE_DEADLINE_EXCEEDED","message":"Deployment did not converge."}}`,
	}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
	}
	if len(requested) != 3 || !strings.HasSuffix(strings.TrimSpace(out), testRevision2ID) {
		t.Fatalf("expected the active revision after one list, deployment and Agent read: %v\n%s", requested, out)
	}
	if !strings.Contains(out, "failed") || !strings.Contains(out, "CONVERGENCE_DEADLINE_EXCEEDED") {
		t.Fatalf("expected the latest deployment failure:\n%s", out)
	}
}

// Revision lists are permission-filtered: without a DEPLOYMENT_ID the command
// reads the latest revision the caller can read, which can be an old failed
// version while the active one is hidden. It must say which one it showed (D608).
func TestDeploymentStatusNamesTheRevisionItChose(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	forbidden := `raw:403 {"error":{"code":"FORBIDDEN","message":"The exact platform operation was not authorized."}}`
	olderOnly := `[{"id":"` + testRevision1ID + `","revision":1}]`
	for _, test := range []struct {
		name      string
		responses map[string]string
		notice    string
	}{
		{"active revision unreadable", map[string]string{
			"GET " + agentPath:                                     `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision2ID + `"}`,
			"GET " + agentPath + "/revisions":                      olderOnly,
			"GET " + agentPath + "/revisions/" + testRevision2ID:   forbidden,
			"GET " + agentPath + "/deployments/" + testRevision1ID: `{"deploymentId":"` + testRevision1ID + `","status":"failed"}`,
		}, "notice: showing revision " + testRevision1ID + ", the latest revision you can read; the active revision " + testRevision2ID + " is not readable with your permissions\n"},
		{"newer than the active revision", map[string]string{
			"GET " + agentPath:                                     `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision1ID + `"}`,
			"GET " + agentPath + "/revisions":                      agentRevisionsResponse(),
			"GET " + agentPath + "/revisions/" + testRevision1ID:   `{"id":"` + testRevision1ID + `","revision":1}`,
			"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","status":"failed"}`,
		}, "notice: showing revision " + testRevision2ID + ", newer than the active revision " + testRevision1ID + `; run "occ --namespace ` + testNamespaceID + ` agent deployment-status ` + testAgentID + " " + testRevision1ID + `" for the active revision` + "\n"},
		{"older than the active revision", map[string]string{
			"GET " + agentPath:                                     `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision2ID + `"}`,
			"GET " + agentPath + "/revisions":                      olderOnly,
			"GET " + agentPath + "/revisions/" + testRevision2ID:   `{"id":"` + testRevision2ID + `","revision":2}`,
			"GET " + agentPath + "/deployments/" + testRevision1ID: `{"deploymentId":"` + testRevision1ID + `","status":"failed"}`,
		}, "notice: showing revision " + testRevision1ID + ", older than the active revision " + testRevision2ID + `; run "occ --namespace ` + testNamespaceID + ` agent deployment-status ` + testAgentID + " " + testRevision2ID + `" for the active revision` + "\n"},
		{"active metadata unavailable", map[string]string{
			"GET " + agentPath:                                     `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision2ID + `"}`,
			"GET " + agentPath + "/revisions":                      olderOnly,
			"GET " + agentPath + "/deployments/" + testRevision1ID: `{"deploymentId":"` + testRevision1ID + `","status":"failed"}`,
		}, "notice: showing revision " + testRevision1ID + ", the latest revision you can read; the active revision is " + testRevision2ID + "\n"},
		{"Agent unreadable", map[string]string{
			"GET " + agentPath:                                     forbidden,
			"GET " + agentPath + "/revisions":                      olderOnly,
			"GET " + agentPath + "/deployments/" + testRevision1ID: `{"deploymentId":"` + testRevision1ID + `","status":"failed"}`,
		}, "notice: showing revision " + testRevision1ID + ", the latest revision you can read\n"},
		{"Agent without an active revision", map[string]string{
			"GET " + agentPath:                                     `{"id":"` + testAgentID + `"}`,
			"GET " + agentPath + "/revisions":                      olderOnly,
			"GET " + agentPath + "/deployments/" + testRevision1ID: `{"deploymentId":"` + testRevision1ID + `","status":"failed"}`,
		}, "notice: showing revision " + testRevision1ID + ", the latest revision you can read; agent " + testAgentID + " has no active revision\n"},
		{"the active revision", map[string]string{
			"GET " + agentPath:                                     `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision2ID + `"}`,
			"GET " + agentPath + "/revisions":                      agentRevisionsResponse(),
			"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","status":"succeeded"}`,
		}, "notice: showing the active revision " + testRevision2ID + "\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, notices, requested, err := runOCCWithNotices(t, test.responses, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
			if err != nil {
				t.Fatalf("%v (requests %v)", err, requested)
			}
			if notices != test.notice {
				t.Fatalf("notices = %q, want %q", notices, test.notice)
			}
			if strings.Contains(out, "notice:") {
				t.Fatalf("notice leaked to stdout:\n%s", out)
			}
		})
	}
}

func TestDeploymentStatusReportsCurrentAgentBesideRecordedSuccess(t *testing.T) {
	path := "GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID
	record := path + "/deployments/" + testRevision1ID
	const reason = "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED"
	for _, tc := range []struct {
		name, agent, cells string
		current            map[string]any
		redeploy           bool
	}{
		{"replaced", `{"desiredRuntimeState":"running","activeRevisionId":"` + testRevision2ID + `"}`, "running " + testRevision2ID, map[string]any{"desiredRuntimeState": "running", "activeRevisionId": testRevision2ID}, false},
		{"retired", `{"desiredRuntimeState":"running"}`, "running none", map[string]any{"desiredRuntimeState": "running", "activeRevisionId": nil}, true},
		{"stopped", `{"desiredRuntimeState":"stopped"}`, "stopped none", map[string]any{"desiredRuntimeState": "stopped", "activeRevisionId": nil}, false},
		{"revision-only reader", `raw:403 {"error":{"code":"FORBIDDEN","message":"Denied."}}`, "", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deployment := `{"deploymentId":"` + testRevision1ID + `","status":"succeeded"`
			wantRow := strings.TrimSpace(testRevision1ID + " - succeeded - - " + tc.cells)
			if tc.redeploy {
				deployment += `,"repositoryAccess":{"state":"redeploy-required","code":"` + reason + `","message":"Deploy again."}`
				wantRow += " " + reason + ": Deploy again."
			}
			responses := map[string]string{path: tc.agent, record: deployment + "}"}
			args := []string{"--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, testRevision1ID}
			out, _, err := runOCC(t, responses, args...)
			_, row, _ := strings.Cut(out, "\n")
			if err != nil || strings.Join(strings.Fields(row), " ") != wantRow {
				t.Fatalf("table = %q, want row %q, error %v", out, wantRow, err)
			}
			out, _, err = runOCC(t, responses, append(args, "-o", "json")...)
			var got map[string]any
			if err != nil || json.Unmarshal([]byte(out), &got) != nil {
				t.Fatalf("JSON = %q, error %v", out, err)
			}
			current, present := got["currentAgent"]
			if got["status"] != "succeeded" || strings.Contains(out, reason) != tc.redeploy || present != (tc.current != nil) || (present && !reflect.DeepEqual(current, tc.current)) {
				t.Fatalf("unexpected deployment: %s", out)
			}
		})
	}
}

func TestDeploymentStatusShowsModelProbeFailureCause(t *testing.T) {
	// Finding 323: a failed startup model check names its classified cause.
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses := map[string]string{
		"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","agentId":"` + testAgentID +
			`","namespaceId":"` + testNamespaceID + `","status":"failed","error":{"code":"RUNTIME_MODEL_PROBE_FAILED",` +
			`"message":"Deployment runtime startup model check failed.","data":{"runtimeFailure":{"component":"gateway",` +
			`"check":"model-probe","checkedAt":"2026-10-03T08:00:00.000Z","code":"MODEL_PROBE_FAILED",` +
			`"cause":{"kind":"PROBE_STATUS","detail":"rate_limit"}}}}}`,
	}
	for _, output := range []string{"table", "json"} {
		out, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "--output", output, "agent", "deployment-status", testAgentID, testRevision2ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"RUNTIME_MODEL_PROBE_FAILED", "PROBE_STATUS", "rate_limit"} {
			if !strings.Contains(out, want) {
				t.Fatalf("%s output lacks %s:\n%s", output, want, out)
			}
		}
	}
}

func TestDeploymentStatusTableShowsStartupWarnings(t *testing.T) {
	// D331: a succeeded deployment that disabled a plugin must not look clean.
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses := map[string]string{
		"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","agentId":"` + testAgentID +
			`","namespaceId":"` + testNamespaceID + `","status":"succeeded","warnings":[` +
			`{"code":"PLUGIN_AUTH_REQUIRED","pluginId":"linear@openai-curated-remote"},` +
			`{"code":"PLUGIN_INSTALL_FAILED","pluginId":"diffs@openai-curated"}]}`,
	}
	out, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, testRevision2ID)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "WARNINGS") {
		t.Fatalf("expected a WARNINGS column:\n%s", out)
	}
	if !strings.HasSuffix(lines[1], "linear@openai-curated-remote (PLUGIN_AUTH_REQUIRED), diffs@openai-curated (PLUGIN_INSTALL_FAILED)") {
		t.Fatalf("expected each warning in the table row:\n%s", out)
	}

	responses["GET "+agentPath+"/deployments/"+testRevision2ID] = `{"deploymentId":"` + testRevision2ID + `","agentId":"` + testAgentID +
		`","namespaceId":"` + testNamespaceID + `","status":"succeeded"}`
	out, _, err = runOCC(t, responses, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, testRevision2ID)
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Split(strings.TrimSpace(out), "\n"); len(lines) != 2 || len(strings.Fields(lines[1])) != 5 || !strings.HasSuffix(lines[1], " -") {
		t.Fatalf("expected empty ERROR and WARNINGS cells:\n%s", out)
	}

	responses["GET "+agentPath+"/deployments/"+testRevision2ID] = `{"deploymentId":"` + testRevision2ID +
		`","status":"succeeded","warnings":[{"code":"PLUGIN_AUTH_REQUIRED","pluginId":"linear@openai-curated-remote"}]}`
	out, _, err = runOCC(t, responses, "--namespace", testNamespaceID, "--output", "json", "agent", "deployment-status", testAgentID, testRevision2ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"pluginId": "linear@openai-curated-remote"`) {
		t.Fatalf("expected structured warnings unchanged:\n%s", out)
	}
}

func TestDeploymentStatusTableShowsErrorAsCodeAndMessage(t *testing.T) {
	// D608: the ERROR cell read as raw {code,message} JSON, with any diagnostic data inline.
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	route := "GET " + agentPath + "/deployments/" + testRevision2ID
	deployment := func(deploymentError string) string {
		return `{"deploymentId":"` + testRevision2ID + `","agentId":"` + testAgentID + `","namespaceId":"` +
			testNamespaceID + `","status":"failed","error":` + deploymentError + `}`
	}
	preparation := `{"code":"DEPLOYMENT_PREPARATION_FAILED","message":"Deployment preparation failed.\n\tCheck its Pods.",` +
		`"data":{"preparation":{"reason":"retry_limit","observedAt":"2026-10-16T08:00:00.000Z","startedAt":null,` +
		`"finishedAt":null,"workload":{"kind":"Job","name":"prep","namespace":"ns","uid":"u1"},"pods":[]}}}`
	for _, test := range []struct {
		name, error, want string
	}{
		{
			name:  "code and message",
			error: `{"code":"RUNTIME_AUTHENTICATION_FAILED","message":"The model provider rejected this version's credential. Update the credential, then deploy a new version."}`,
			want:  "RUNTIME_AUTHENTICATION_FAILED: The model provider rejected this version's credential. Update the credential, then deploy a new version.",
		},
		{
			name:  "diagnostic data is replaced by a pointer",
			error: preparation,
			want:  "DEPLOYMENT_PREPARATION_FAILED: Deployment preparation failed. Check its Pods. (details: -o json)",
		},
		{
			name: "model check cause",
			error: `{"code":"RUNTIME_MODEL_PROBE_FAILED","message":"Deployment runtime startup model check failed.","data":{"runtimeFailure":` +
				`{"component":"gateway","check":"model-probe","checkedAt":"2026-10-03T08:00:00.000Z","code":"MODEL_PROBE_FAILED",` +
				`"cause":{"kind":"PROBE_STATUS","detail":"rate_limit"}}}}`,
			want: "RUNTIME_MODEL_PROBE_FAILED: Deployment runtime startup model check failed. (cause: PROBE_STATUS rate_limit)",
		},
		{
			// The cause's detail token is optional; its kind alone is still the cause.
			name: "model check cause without detail",
			error: `{"code":"RUNTIME_MODEL_PROBE_FAILED","message":"Deployment runtime startup model check failed.","data":{"runtimeFailure":` +
				`{"component":"gateway","check":"model-probe","checkedAt":"2026-10-03T08:00:00.000Z","code":"MODEL_PROBE_FAILED",` +
				`"cause":{"kind":"PROCESS_EXIT"}}}}`,
			want: "RUNTIME_MODEL_PROBE_FAILED: Deployment runtime startup model check failed. (cause: PROCESS_EXIT)",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, _, err := runOCC(t, map[string]string{route: deployment(test.error)}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, testRevision2ID)
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSpace(out), "\n")
			if len(lines) != 2 || !strings.HasSuffix(lines[1], "  "+test.want+"  -") {
				t.Fatalf("expected ERROR cell %q:\n%s", test.want, out)
			}
		})
	}

	// Structured output keeps the whole error, the message's line break included.
	for _, output := range []string{"json", "yaml"} {
		out, _, err := runOCC(t, map[string]string{route: deployment(preparation)}, "--namespace", testNamespaceID, "--output", output, "agent", "deployment-status", testAgentID, testRevision2ID)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			Error struct {
				Message string         `yaml:"message"`
				Data    map[string]any `yaml:"data"`
			} `yaml:"error"`
		}
		if err := yaml.Unmarshal([]byte(out), &decoded); err != nil {
			t.Fatalf("%s output: %v\n%s", output, err, out)
		}
		prepared, _ := decoded.Error.Data["preparation"].(map[string]any)
		if decoded.Error.Message != "Deployment preparation failed.\n\tCheck its Pods." || prepared["reason"] != "retry_limit" {
			t.Fatalf("%s output must keep the whole error:\n%s", output, out)
		}
	}
}

func TestDeploymentStatusWithoutRevisionsExplainsHowToDeploy(t *testing.T) {
	// A stale environment scope must not replace the explicitly selected Namespace in the hint.
	t.Setenv("OCC_NAMESPACE", "ns_55555555-5555-4555-8555-555555555555")
	agentPath := "GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID
	_, _, err := runOCC(t, map[string]string{
		agentPath + "/revisions":   `[]`,
		agentPath + "/permissions": `{"update":true,"deploy":true,"operate":true,"delete":true}`,
	}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	if err == nil || !strings.Contains(err.Error(), `run "occ --namespace `+testNamespaceID+` agent deploy `+testAgentID+`" first`) {
		t.Fatalf("expected a deploy hint, got %v", err)
	}
	// The list is filtered by revision read, so a caller who cannot deploy hears
	// which grant lists revisions instead (finding 522).
	_, _, err = runOCC(t, map[string]string{
		agentPath + "/revisions":   `[]`,
		agentPath + "/permissions": `{"update":false,"deploy":false,"operate":false,"delete":false}`,
	}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	want := "agent " + testAgentID + " has no revision you can read; " + revisionReadAdvice
	if err == nil || err.Error() != want {
		t.Fatalf("reader error = %v, want %q", err, want)
	}
}

// Go maps have no order, so JSON output must sort object keys (as YAML does) to be
// diffable from run to run, including nested objects in table cells.
func TestJSONOutputAndTableCellsKeepAStableKeyOrder(t *testing.T) {
	responses := map[string]string{
		"GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID: `{"status":"active","name":"a","id":"` + testAgentID + `","executionMode":"embedded","desiredRuntimeState":"running","createdAt":"2026-09-30T00:00:00.000Z","configurationId":"cfg_00000000-0000-4000-8000-000000000001","activeRevisionId":"rev_00000000-0000-4000-8000-000000000001","servicePrincipalId":"sp_1"}`,
		"GET /namespaces/" + testNamespaceID + "/iam/roles/role_1":      `{"id":"role_1","permissions":[{"resourceKind":"agent","action":"read"}]}`,
	}
	want := `{
  "activeRevisionId": "rev_00000000-0000-4000-8000-000000000001",
  "configurationId": "cfg_00000000-0000-4000-8000-000000000001",
  "createdAt": "2026-09-30T00:00:00.000Z",
  "desiredRuntimeState": "running",
  "executionMode": "embedded",
  "id": "` + testAgentID + `",
  "name": "a",
  "servicePrincipalId": "sp_1",
  "status": "active"
}
`
	for range 20 {
		out, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "-o", "json", "agent", "get", testAgentID)
		if err != nil {
			t.Fatal(err)
		}
		if out != want {
			t.Fatalf("JSON output must list keys in a stable, sorted order:\n%s", out)
		}
		out, _, err = runOCC(t, responses, "--namespace", testNamespaceID, "iam", "role", "get", "role_1")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, `[{"action":"read","resourceKind":"agent"}]`) {
			t.Fatalf("table cells must render nested objects with sorted keys:\n%s", out)
		}
	}
}

func TestServiceKeyCreateWritesAPrivateKeyFileAndNeverPrintsTheKey(t *testing.T) {
	var requests []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]any
		_ = json.UnmarshalRead(request.Body, &body)
		requests = append(requests, body)
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"data":{"id":"key_1","servicePrincipalId":"spn_1","namespaceId":"` +
			testNamespaceID + `","name":"nora","expiresAt":"2026-11-06T00:00:00.000Z","key":"occ_secret"},"meta":{"requestId":"r"}}`))
	}))
	defer server.Close()
	directory := t.TempDir()
	adminKey := filepath.Join(directory, "admin.json")
	if err := os.WriteFile(adminKey, []byte(`{"data":{"key":"admin-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		var out bytes.Buffer
		command := New(&out, &bytes.Buffer{})
		command.SetArgs(append([]string{"--url", server.URL, "--service-key-file", adminKey, "--namespace", testNamespaceID, "service-key", "create", "--service-principal", "spn_1", "--name", "nora"}, args...))
		err := command.Execute()
		return out.String(), err
	}

	// An out-of-range lifetime fails before any request and leaves no file behind.
	rejected := filepath.Join(directory, "rejected.json")
	if _, err := run("--out", rejected, "--expires-in-days", "400"); err == nil || !strings.Contains(err.Error(), "between 1 and 365") {
		t.Fatalf("expires-in-days 400 error = %v", err)
	}
	if _, err := os.Stat(rejected); !os.IsNotExist(err) || len(requests) != 0 {
		t.Fatalf("rejected lifetime left a file (%v) or sent %d requests", err, len(requests))
	}

	keyFile := filepath.Join(directory, "nora.json")
	out, err := run("--out", keyFile, "--expires-in-days", "2")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "occ_secret") || !strings.Contains(out, "key_1") {
		t.Fatalf("table output must name the key ID and never the key:\n%s", out)
	}
	if len(requests) != 1 || requests[0]["namespaceId"] != testNamespaceID || requests[0]["expiresIn"] != float64(2*24*60*60) {
		t.Fatalf("unexpected issuance request: %v", requests)
	}
	info, err := os.Stat(keyFile)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode = %v, %v; want 0600", info, err)
	}
	contents, err := os.ReadFile(keyFile)
	if err != nil || !strings.Contains(string(contents), `"key":"occ_secret"`) || !strings.HasPrefix(string(contents), `{"data":`) {
		t.Fatalf("key file is not the issuance envelope: %s, %v", contents, err)
	}
}

func TestServiceKeyCreateLeavesNoKeyFileWhenItCannotSaveAKey(t *testing.T) {
	requests := 0
	var lastBody map[string]any
	status, response := http.StatusForbidden, `{"error":{"code":"FORBIDDEN","message":"denied"}}`
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		lastBody = nil
		_ = json.UnmarshalRead(request.Body, &lastBody)
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(response))
	}))
	defer server.Close()
	directory := t.TempDir()
	adminKey := filepath.Join(directory, "admin.json")
	if err := os.WriteFile(adminKey, []byte(`{"data":{"key":"admin-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(directory, "nora.json")
	run := func(namespace string, args ...string) error {
		command := New(&bytes.Buffer{}, &bytes.Buffer{})
		command.SetArgs(append([]string{"--url", server.URL, "--service-key-file", adminKey, "--namespace", namespace, "service-key", "create", "--service-principal", "spn_1", "--name", "nora", "--out", keyFile}, args...))
		return command.Execute()
	}
	assertNoKeyFile := func(step string) {
		t.Helper()
		if _, err := os.Stat(keyFile); !os.IsNotExist(err) {
			t.Fatalf("%s left a key file: %v", step, err)
		}
	}

	// Lifetimes outside 1-365 days and malformed Namespace IDs fail before any request.
	for _, refused := range []struct{ namespace, flag, message string }{
		{testNamespaceID, "--expires-in-days=0", "between 1 and 365"},
		{testNamespaceID, "--expires-in-days=366", "between 1 and 365"},
		{testNamespaceID, "--expires-in-days=-1", "between 1 and 365"},
		{"default", "--expires-in-days=1", "OCC_NAMESPACE or --namespace"},
	} {
		if err := run(refused.namespace, refused.flag); err == nil || !strings.Contains(err.Error(), refused.message) {
			t.Fatalf("%s %s: error = %v", refused.namespace, refused.flag, err)
		}
		assertNoKeyFile(refused.namespace + " " + refused.flag)
	}
	if requests != 0 {
		t.Fatalf("refused arguments sent %d requests", requests)
	}

	// 365 days is accepted and sent. The server refuses the issuance, so the empty file is removed.
	if err := run(testNamespaceID, "--expires-in-days=365"); err == nil || requests != 1 || lastBody["expiresIn"] != float64(365*24*60*60) {
		t.Fatalf("refused issuance: error = %v after %d requests, last body %v", err, requests, lastBody)
	}
	assertNoKeyFile("a refused issuance")

	// A response without a key ID is refused rather than saved as a key file.
	status, response = http.StatusCreated, `{"data":{"name":"nora","key":"occ_secret"},"meta":{"requestId":"r"}}`
	if err := run(testNamespaceID); err == nil || !strings.Contains(err.Error(), "invalid service key") {
		t.Fatalf("response without a key ID: error = %v", err)
	}
	assertNoKeyFile("a response without a key ID")
}

func TestServiceKeyCreateRejectsNamesTheAPIRefusesBeforeAnyRequest(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"data":{"id":"key_1","name":"nora","key":"occ_secret"},"meta":{"requestId":"r"}}`))
	}))
	defer server.Close()
	directory := t.TempDir()
	adminKey := filepath.Join(directory, "admin.json")
	if err := os.WriteFile(adminKey, []byte(`{"data":{"key":"admin-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// The API counts code points, so 33 emoji are too long although 32 fit.
	for _, name := range []string{strings.Repeat("a", 33), strings.Repeat("😀", 33), "   "} {
		requests = 0
		keyFile := filepath.Join(directory, "rejected-"+name+".json")
		command := New(&bytes.Buffer{}, &bytes.Buffer{})
		command.SetArgs([]string{
			"--url", server.URL,
			"--service-key-file", adminKey,
			"--namespace", testNamespaceID,
			"service-key", "create",
			"--service-principal", "spn_1",
			"--name", name,
			"--out", keyFile,
		})
		err := command.Execute()
		if err == nil || !strings.Contains(err.Error(), "1 to 32 characters") {
			t.Fatalf("name %q: error = %v", name, err)
		}
		if requests != 0 {
			t.Fatalf("name %q sent %d requests", name, requests)
		}
		if _, statErr := os.Stat(keyFile); !os.IsNotExist(statErr) {
			t.Fatalf("name %q left a key file: %v", name, statErr)
		}
	}

	for index, name := range []string{strings.Repeat("a", 32), strings.Repeat("😀", 32)} {
		requests = 0
		keyFile := filepath.Join(directory, "accepted-"+strconv.Itoa(index)+".json")
		command := New(&bytes.Buffer{}, &bytes.Buffer{})
		command.SetArgs([]string{
			"--url", server.URL,
			"--service-key-file", adminKey,
			"--namespace", testNamespaceID,
			"service-key", "create",
			"--service-principal", "spn_1",
			"--name", name,
			"--out", keyFile,
		})
		if err := command.Execute(); err != nil || requests != 1 {
			t.Fatalf("32-character name %q: error = %v after %d requests", name, err, requests)
		}
	}
}

func TestNamespaceCreateRejectsExistingNamespacesTheAPIRefuses(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"data":{"id":"ns_11111111-1111-4111-8111-111111111111","name":"support","status":"provisioning","existingNamespace":"customer-support-prod"},"meta":{"requestId":"r"}}`))
	}))
	defer server.Close()
	directory := t.TempDir()
	adminKey := filepath.Join(directory, "admin.json")
	if err := os.WriteFile(adminKey, []byte(`{"data":{"key":"admin-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) error {
		command := New(&bytes.Buffer{}, &bytes.Buffer{})
		command.SetArgs(append([]string{"--url", server.URL, "--service-key-file", adminKey, "namespace", "create"}, args...))
		return command.Execute()
	}
	for _, name := range []string{"", "Bad_Name", strings.Repeat("a", 64)} {
		requests = 0
		err := run("support", "--existing-namespace", name)
		if err == nil || !strings.Contains(err.Error(), "DNS-1123 label of at most 63 characters") {
			t.Fatalf("existing namespace %q: error = %v", name, err)
		}
		if requests != 0 {
			t.Fatalf("existing namespace %q sent %d requests", name, requests)
		}
	}
	requests = 0
	if err := run("support"); err != nil || requests != 1 {
		t.Fatalf("omitted adoption flag: error = %v after %d requests", err, requests)
	}
	requests = 0
	if err := run("support", "--existing-namespace", "customer-support-prod"); err != nil || requests != 1 {
		t.Fatalf("DNS label: error = %v after %d requests", err, requests)
	}
}

func TestAgentBrowsingShowsUnreadableSavedSettings(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	unreadable := `{"id":"` + testAgentID + `","name":"legacy","configurationReadError":{"code":"SAVED_CONFIGURATION_UNREADABLE","field":"plugins"}}`
	for _, command := range [][]string{{"agent", "get", testAgentID}, {"agent", "list"}} {
		responses := map[string]string{"GET " + agentPath: unreadable, "GET /namespaces/" + testNamespaceID + "/agents": "[" + unreadable + "]"}
		out, _, err := runOCC(t, responses, append([]string{"--namespace", testNamespaceID}, command...)...)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "CONFIGURATION ERROR") || !strings.Contains(out, "SAVED_CONFIGURATION_UNREADABLE (plugins)") {
			t.Fatalf("error variant must remain visible: %s", out)
		}
	}
}

// OCC reads each listed revision's deployment status with the list, without
// decoding saved settings. The CLI shows those statuses as OCC listed them, even
// when the Agent's or a revision's saved settings are unreadable and their exact
// deployment status reads fail (503), and sends no read per revision.
func TestAgentRevisionsShowTheStatusOCCListed(t *testing.T) {
	responses := agentRevisionResponses()
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses["GET "+agentPath] = `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision1ID + `","configurationReadError":{"code":"SAVED_CONFIGURATION_UNREADABLE","field":"plugins"}}`
	unavailable := `raw:503 {"error":{"code":"DEPENDENCY_UNAVAILABLE","message":"Persisted AgentRevision plugin state is invalid."}}`
	responses["GET "+agentPath+"/deployments/"+testRevision1ID] = unavailable
	responses["GET "+agentPath+"/deployments/"+testRevision2ID] = unavailable
	for _, format := range []string{"table", "json", "yaml"} {
		out, notices, requested, err := runOCCWithNotices(t, responses, "--namespace", testNamespaceID, "--output", format, "agent", "revisions", testAgentID)
		if err != nil {
			t.Fatal(err)
		}
		for _, request := range requested {
			if strings.Contains(request, "/deployments/") {
				t.Fatalf("%s: the list already carries each status; unexpected %s", format, request)
			}
		}
		if notices != "" {
			t.Fatalf("%s: no status is unavailable: %q", format, notices)
		}
		if format == "table" {
			lines := strings.Split(strings.TrimSpace(out), "\n")
			if len(lines) != 3 || strings.Fields(lines[1])[3] != "failed" || strings.Fields(lines[2])[4] != "succeeded" {
				t.Fatalf("table must show the listed statuses:\n%s", out)
			}
			continue
		}
		var rows []map[string]any
		if format == "json" {
			err = json.Unmarshal([]byte(out), &rows)
		} else {
			err = yaml.Unmarshal([]byte(out), &rows)
		}
		if err != nil || len(rows) != 2 {
			t.Fatalf("%s: %v\n%s", format, err, out)
		}
		if rows[0]["deploymentStatus"] != "failed" || rows[0]["deploymentErrorCode"] != "CONVERGENCE_DEADLINE_EXCEEDED" || rows[1]["deploymentStatus"] != "succeeded" {
			t.Fatalf("%s must keep the listed statuses: %v", format, rows)
		}
	}
}

// OCC lists deployment work that a newer revision or a Stop ended as failed,
// with the code that says so. The table has no error column, so its STATUS
// names that ending, as the console does; json and yaml keep OCC's fields.
// REPOSITORY_REVISION_STOPPED and AUTHORIZATION_DENIED are real failures.
func TestAgentRevisionsTableNamesNeutralEndings(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	for _, c := range []struct {
		status, code, shown string
	}{
		{"failed", "REVISION_SUPERSEDED", "superseded"},
		{"failed", "REPOSITORY_REVISION_SUPERSEDED", "superseded"},
		{"failed", "REVISION_STOPPED", "stopped"},
		{"failed", "REPOSITORY_REVISION_STOPPED", "failed"},
		{"failed", "AUTHORIZATION_DENIED", "failed"},
		// Only a failed status is relabelled.
		{"succeeded", "REVISION_SUPERSEDED", "succeeded"},
	} {
		responses := agentRevisionResponses()
		responses["GET "+agentPath+"/revisions"] = `[{"id":"` + testRevision2ID + `","revision":2,"agentId":"` + testAgentID + `","configurationGeneration":2,"createdAt":"2026-09-30T01:00:00.000Z","deploymentStatus":"` + c.status + `","deploymentErrorCode":"` + c.code + `"}]`
		out, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "agent", "revisions", testAgentID)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if len(lines) != 2 || !strings.Contains(lines[0], "STATUS") || strings.Fields(lines[1])[3] != c.shown {
			t.Fatalf("%s %s: STATUS must read %s:\n%s", c.status, c.code, c.shown, out)
		}
		for _, format := range []string{"json", "yaml"} {
			out, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "-o", format, "agent", "revisions", testAgentID)
			if err != nil {
				t.Fatal(err)
			}
			var rows []map[string]any
			if format == "json" {
				err = json.Unmarshal([]byte(out), &rows)
			} else {
				err = yaml.Unmarshal([]byte(out), &rows)
			}
			if err != nil || len(rows) != 1 || rows[0]["deploymentStatus"] != c.status || rows[0]["deploymentErrorCode"] != c.code {
				t.Fatalf("%s %s: %s must keep OCC's fields: %v\n%s", c.status, c.code, format, err, out)
			}
		}
	}
}

// The revisions command shows one page; it passes --limit and --cursor through
// and prints how to read the next page.
func TestAgentRevisionsPagesWithCursor(t *testing.T) {
	// A stale environment scope must not replace the explicitly selected Namespace.
	t.Setenv("OCC_NAMESPACE", "ns_55555555-5555-4555-8555-555555555555")
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	firstResponses := agentRevisionResponses()
	firstResponses["GET "+agentPath+"/revisions"] = `raw:200 {"data":[{"id":"` + testRevision2ID + `","revision":2,"namespaceId":"` + testNamespaceID + `","agentId":"` + testAgentID + `","backendId":null,"configurationId":"cfg_55555555-5555-4555-8555-555555555555","harness":{"id":"codex","version":"fixture","mode":"dedicated","overrides":{},"configuration":{}},"configurationGeneration":2,"createdAt":"2026-09-30T01:00:00.000Z","deploymentStatus":"failed","deploymentErrorCode":"CONVERGENCE_DEADLINE_EXCEEDED"}],"meta":{"requestId":"req_66666666-6666-4666-8666-666666666666","nextCursor":"v1.2"}}`
	lastResponses := agentRevisionResponses()
	lastResponses["GET "+agentPath+"/revisions"] = `raw:200 {"data":[{"id":"` + testRevision1ID + `","revision":1,"namespaceId":"` + testNamespaceID + `","agentId":"` + testAgentID + `","backendId":null,"configurationId":"cfg_55555555-5555-4555-8555-555555555555","harness":{"id":"codex","version":"fixture","mode":"dedicated","overrides":{},"configuration":{}},"configurationGeneration":1,"createdAt":"2026-09-30T00:00:00.000Z","deploymentStatus":"succeeded","deploymentErrorCode":null}],"meta":{"requestId":"req_66666666-6666-4666-8666-666666666666","nextCursor":null}}`
	first := &fakeOCC{responses: firstResponses}
	last := &fakeOCC{responses: lastResponses}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "v1.2" {
			last.ServeHTTP(w, r)
			return
		}
		first.ServeHTTP(w, r)
	}))
	defer server.Close()
	t.Setenv("OCC_URL", server.URL)
	t.Setenv("OCC_SERVICE_KEY_FILE", writeKeyFile(t, `{"data":{"key":"test-key"}}`))
	t.Setenv("OCC_CA_BUNDLE", "")
	t.Setenv("OCC_TIMEOUT_SECONDS", "5")
	out, notices, err := runOCCWithArgs("--namespace", testNamespaceID, "agent", "revisions", testAgentID, "--limit", "1", "--cursor", "v1.3")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(first.requested, "GET "+agentPath+"/revisions?cursor=v1.3&limit=1") {
		t.Fatalf("limit and cursor must reach OCC: %v", first.requested)
	}
	if !strings.Contains(out, testRevision2ID) || strings.Contains(out, testRevision1ID) {
		t.Fatalf("expected only the page's revision:\n%s", out)
	}
	nextOut, nextNotices, err := runOCCWithArgs(nextPageCommand(t, notices)...)
	if err != nil {
		t.Fatalf("advertised next-page command failed: %v", err)
	}
	if !slices.Contains(last.requested, "GET "+agentPath+"/revisions?cursor=v1.2&limit=1") || !strings.Contains(nextOut, testRevision1ID) {
		t.Fatalf("next-page command lost the selected Namespace, limit, or cursor: %v\n%s", last.requested, nextOut)
	}
	if nextNotices != "" {
		t.Fatalf("last page printed a continuation: %q", nextNotices)
	}
	for _, limit := range []string{"0", "101"} {
		if _, _, err := runOCCWithArgs("--namespace", testNamespaceID, "agent", "revisions", testAgentID, "--limit", limit); err == nil {
			t.Fatalf("--limit %s must be refused locally", limit)
		}
	}

	// A default page contains 50 readable revisions; revision 1 is the
	// lookahead that makes v1.2 a valid continuation. The hint must not add
	// --limit 0, which the CLI would reject.
	var defaultPage []map[string]any
	for revision := 51; revision >= 2; revision-- {
		id := fmt.Sprintf("rev_00000000-0000-4000-8000-%012d", revision)
		if revision == 2 {
			id = testRevision2ID
		}
		defaultPage = append(defaultPage, map[string]any{
			"id":              id,
			"revision":        revision,
			"agentId":         testAgentID,
			"namespaceId":     testNamespaceID,
			"backendId":       nil,
			"configurationId": "cfg_55555555-5555-4555-8555-555555555555",
			"harness": map[string]any{
				"id": "codex", "version": "fixture", "mode": "dedicated",
				"overrides": map[string]any{}, "configuration": map[string]any{},
			},
			"configurationGeneration": 2,
			"createdAt":               "2026-09-30T01:00:00.000Z",
			"deploymentStatus":        "failed",
			"deploymentErrorCode":     "CONVERGENCE_DEADLINE_EXCEEDED",
		})
	}
	pageJSON, err := json.Marshal(defaultPage)
	if err != nil {
		t.Fatal(err)
	}
	firstResponses["GET "+agentPath+"/revisions"] = `raw:200 {"data":` + string(pageJSON) + `,"meta":{"requestId":"req_66666666-6666-4666-8666-666666666666","nextCursor":"v1.2"}}`
	_, notices, err = runOCCWithArgs("--namespace", testNamespaceID, "agent", "revisions", testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(first.requested, "GET "+agentPath+"/revisions") {
		t.Fatalf("an unset --limit must send no limit: %v", first.requested)
	}
	if next := nextPageCommand(t, notices); slices.Contains(next, "--limit") {
		t.Fatalf("next-page command adds a --limit the caller did not pass: %q", next)
	}
}

// A page is incomplete without its continuation notice. A failed stderr write
// must not report success after printing only that page, including JSON output.
func TestAgentRevisionsReportsContinuationWriteFailure(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	writeErr := errors.New("continuation output unavailable")
	for _, format := range []string{"table", "json"} {
		for _, cursor := range []string{"v1.2", ""} {
			t.Run(format+"/"+cursor, func(t *testing.T) {
				responses := agentRevisionResponses()
				cursorJSON := "null"
				if cursor != "" {
					cursorJSON = strconv.Quote(cursor)
				}
				responses["GET "+agentPath+"/revisions"] = `raw:200 {"data":[{"id":"` + testRevision2ID + `","revision":2,"namespaceId":"` + testNamespaceID + `","agentId":"` + testAgentID + `","backendId":null,"configurationId":"cfg_55555555-5555-4555-8555-555555555555","harness":{"id":"codex","version":"fixture","mode":"dedicated","overrides":{},"configuration":{}},"configurationGeneration":2,"createdAt":"2026-09-30T01:00:00.000Z","deploymentStatus":"failed","deploymentErrorCode":"CONVERGENCE_DEADLINE_EXCEEDED"}],"meta":{"requestId":"req_test","nextCursor":` + cursorJSON + `}}`
				fake := &fakeOCC{responses: responses}
				server := httptest.NewServer(fake)
				defer server.Close()
				t.Setenv("OCC_URL", server.URL)
				t.Setenv("OCC_SERVICE_KEY_FILE", writeKeyFile(t, `{"data":{"key":"test-key"}}`))
				t.Setenv("OCC_CA_BUNDLE", "")
				t.Setenv("OCC_TIMEOUT_SECONDS", "5")
				var out, notice bytes.Buffer
				command := New(&out, logOutputFunc(func(data []byte) (int, error) {
					notice.Write(data)
					return 0, writeErr
				}))
				args := []string{"--namespace", testNamespaceID, "agent", "revisions", testAgentID, "--limit", "1"}
				// Preserve both the complete-command branch and the explicit-override branch.
				if format == "json" {
					args = append(args, "-o", format)
				}
				command.SetArgs(args)
				err := command.Execute()
				if cursor != "" {
					if !errors.Is(err, writeErr) {
						t.Fatalf("continuation failure = %v, want %v", err, writeErr)
					}
					if !strings.Contains(notice.String(), "--cursor "+cursor) {
						t.Fatalf("missing attempted continuation: %q", notice.String())
					}
				} else if err != nil || notice.Len() != 0 {
					t.Fatalf("last page: error=%v notice=%q", err, notice.String())
				}
				if !strings.Contains(out.String(), testRevision2ID) {
					t.Fatalf("page was not delivered: %q", out.String())
				}
				if want := []string{"GET " + agentPath + "/revisions?limit=1", "GET " + agentPath}; !slices.Equal(fake.requested, want) {
					t.Fatalf("requests=%v, want one page and Agent read %v", fake.requested, want)
				}
			})
		}
	}
}

func TestAgentRevisionsContinuationKeepsOverrides(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses := agentRevisionResponses()
	// With --limit 1, revision 2 fills the page and readable revision 1
	// allows OCC to return v1.2 as the next cursor.
	responses["GET "+agentPath+"/revisions"] = `raw:200 {"data":[{"id":"` + testRevision2ID + `","revision":2,"namespaceId":"` + testNamespaceID + `","agentId":"` + testAgentID + `","backendId":null,"configurationId":"cfg_55555555-5555-4555-8555-555555555555","harness":{"id":"codex","version":"fixture","mode":"dedicated","overrides":{},"configuration":{}},"configurationGeneration":2,"createdAt":"2026-09-30T01:00:00.000Z","deploymentStatus":"failed","deploymentErrorCode":"CONVERGENCE_DEADLINE_EXCEEDED"}],"meta":{"requestId":"req_66666666-6666-4666-8666-666666666666","nextCursor":"v1.2"}}`
	server := httptest.NewServer(&fakeOCC{responses: responses})
	defer server.Close()
	keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
	t.Setenv("OCC_URL", server.URL)
	t.Setenv("OCC_SERVICE_KEY_FILE", keyFile)
	t.Setenv("OCC_CA_BUNDLE", "")
	t.Setenv("OCC_TIMEOUT_SECONDS", "5")
	t.Setenv("OCC_NAMESPACE", "")
	for _, flag := range []struct {
		name, arg string
	}{
		{"url", "--url=" + server.URL},
		{"service-key-file", "--service-key-file=" + keyFile},
		{"ca-bundle", "--ca-bundle="},
		{"timeout-seconds", "--timeout-seconds=9"},
		{"output", "-o=json"},
	} {
		t.Run(flag.name, func(t *testing.T) {
			if flag.name == "url" {
				t.Setenv("OCC_URL", "")
			}
			if flag.name == "service-key-file" {
				t.Setenv("OCC_SERVICE_KEY_FILE", "")
			}
			out, notices, err := runOCCWithArgs(flag.arg, "--namespace", testNamespaceID, "agent", "revisions", testAgentID, "--limit", "1")
			if err != nil {
				t.Fatal(err)
			}
			if flag.name == "output" {
				var rows []map[string]any
				if err := json.Unmarshal([]byte(out), &rows); err != nil || len(rows) != 1 || rows[0]["id"] != testRevision2ID {
					t.Fatalf("expected revision 2 as JSON, got %q (error %v)", out, err)
				}
			}
			if !strings.Contains(notices, "repeat the same command") || !strings.Contains(notices, "--cursor v1.2") ||
				strings.Contains(notices, "occ --namespace") || strings.Contains(notices, server.URL) || strings.Contains(notices, keyFile) {
				t.Fatalf("expected a cursor hint that preserves the invocation without printing connection settings, got %q", notices)
			}
		})
	}
}

// A revision list without data is a malformed answer, not an Agent without revisions.
func TestAgentRevisionsRefusesAPageWithoutData(t *testing.T) {
	responses := agentRevisionResponses()
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses["GET "+agentPath+"/revisions"] = `raw:200 {"meta":{"requestId":"req_test"}}`
	_, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "agent", "revisions", testAgentID)
	if err == nil || err.Error() != "OCC returned an invalid response (HTTP 200)" {
		t.Fatalf("error = %v, want the invalid response refusal", err)
	}
}

// The default revision lookup stops when OCC hands back the cursor it was sent, as
// older servers can, instead of asking for the same empty page forever.
func TestDefaultRevisionLookupStopsAtARepeatedCursor(t *testing.T) {
	responses := agentRevisionResponses()
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses["GET "+agentPath+"/revisions"] = `raw:200 {"data":[],"meta":{"requestId":"req_test","nextCursor":"v1.2"}}`
	fake := &fakeOCC{responses: responses}
	var lists []string
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == agentPath+"/revisions" {
			lists = append(lists, request.URL.RawQuery)
			if len(lists) > 3 {
				// Bound a looping client so a regression fails instead of hanging.
				writer.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}
		fake.ServeHTTP(writer, request)
	})
	_, _, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	if err == nil || !strings.HasPrefix(err.Error(), "agent "+testAgentID+" has no revision you can read") {
		t.Fatalf("error = %v, want the no readable revision refusal", err)
	}
	if want := []string{"limit=100", "cursor=v1.2&limit=100"}; !slices.Equal(lists, want) {
		t.Fatalf("revision list queries = %q, want %q", lists, want)
	}
}

// OCC answers a delete with a bodyless 204; any other success is malformed.
func TestDeleteRefusesASuccessOtherThanNoContent(t *testing.T) {
	path := "/namespaces/" + testNamespaceID + "/configurations/cfg_00000000-0000-4000-8000-000000000001"
	_, _, err := runOCC(t, map[string]string{"DELETE " + path: "raw:200 "}, "--namespace", testNamespaceID, "configuration", "delete", "cfg_00000000-0000-4000-8000-000000000001")
	if err == nil || err.Error() != "OCC returned an invalid empty response (HTTP 200)" {
		t.Fatalf("error = %v, want the invalid empty response refusal", err)
	}
}

// nextPageCommand returns the arguments of the "occ ..." command that an
// agent revisions notice advertises for the next page, without "occ".
func nextPageCommand(t *testing.T, notices string) []string {
	t.Helper()
	_, continuation, found := strings.Cut(notices, `older revisions may exist; run "`)
	if !found {
		t.Fatalf("missing next-page command: %q", notices)
	}
	continuation, _, _ = strings.Cut(continuation, `"`)
	return strings.Fields(continuation)[1:]
}

// Subject IDs are opaque and can match across identities and groups. Tables
// must preserve the discriminator that decides whether the grant is direct.
func TestIAMAccessBindingTablesDistinguishIdentityAndGroupSubjects(t *testing.T) {
	const identity = `{"id":"binding_direct","namespaceId":"` + testNamespaceID + `","subjectKind":"identity","subjectId":"operators","roleId":"role_read","resourceKind":"agent","resourceId":"` + testAgentID + `"}`
	const group = `{"id":"binding_group","namespaceId":"` + testNamespaceID + `","subjectKind":"group","subjectId":"operators","roleId":"role_read","resourceKind":"agent","resourceId":"` + testAgentID + `"}`
	path := "GET /namespaces/" + testNamespaceID + "/iam/access-bindings"
	responses := map[string]string{path: "[" + identity + "," + group + "]", path + "/binding_direct": identity, path + "/binding_group": group}
	for _, args := range [][]string{{"list"}, {"get", "binding_direct"}, {"get", "binding_group"}} {
		out, _, err := runOCC(t, responses, append([]string{"--namespace", testNamespaceID, "iam", "access-binding"}, args...)...)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "SUBJECT KIND") {
			t.Fatalf("table must identify the subject kind:\n%s", out)
		}
		lines := strings.Split(strings.TrimSpace(out), "\n")[1:]
		wantRows := 1
		if args[0] == "list" {
			wantRows = 2
		}
		if len(lines) != wantRows {
			t.Fatalf("expected %d binding rows: %s", wantRows, out)
		}
		for _, line := range lines {
			fields := strings.Fields(line)
			if len(fields) != 6 {
				t.Fatalf("expected the binding columns: %s", line)
			}
			want := "identity"
			if fields[0] == "binding_group" {
				want = "group"
			}
			if len(fields) != 6 || fields[1] != want || fields[2] != "operators" {
				t.Fatalf("table must keep %s subject beside its opaque ID: %s", want, line)
			}
		}
	}
}

func TestFirstDeploymentCommandsUseExplicitRoutes(t *testing.T) {
	configurationID := "cfg_55555555-5555-4555-8555-555555555555"
	path := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/deploy-first"
	for _, command := range []string{"deploy-first", "recover-first-deployment"} {
		t.Run(command, func(t *testing.T) {
			calls := 0
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				expectedPath := path
				if command == "recover-first-deployment" {
					expectedPath += "/review-1/" + configurationID + "/3"
				}
				if r.URL.Path != expectedPath {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				if command == "deploy-first" {
					if r.Method != http.MethodPost {
						t.Errorf("method = %s", r.Method)
					}
					var body map[string]any
					if err := json.UnmarshalRead(r.Body, &body); err != nil {
						t.Fatal(err)
					}
					if body["key"] != "review-1" || body["expectedConfigurationId"] != configurationID || body["expectedGeneration"] != float64(3) {
						t.Errorf("body = %#v", body)
					}
				} else {
					if r.Method != http.MethodGet || r.ContentLength > 0 {
						t.Errorf("recovery must be bodyless GET")
					}
					if r.URL.RawQuery != "" {
						t.Errorf("unexpected query: %s", r.URL.RawQuery)
					}

				}
				w.Header().Set("Content-Type", "application/json")
				if command == "deploy-first" {
					w.WriteHeader(http.StatusAccepted)
				}
				_, _ = w.Write([]byte(`{"data":{"revisionId":"` + testRevision1ID + `","namespaceId":"` + testNamespaceID + `","agentId":"` + testAgentID + `","configurationId":"` + configurationID + `","configurationGeneration":3,"createdAt":"2026-10-30T00:00:00.000Z"},"meta":{"requestId":"test"}}`))
			})
			stdout, stderr, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "--output", "json", "agent", command, testAgentID, "--key", "review-1", "--configuration", configurationID, "--generation", "3")
			if err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("requests = %d", calls)
			}
			var receipt map[string]any
			if err := json.Unmarshal([]byte(stdout), &receipt); err != nil {
				t.Fatal(err)
			}
			if len(receipt) != 6 || receipt["revisionId"] != testRevision1ID || receipt["configurationGeneration"] != float64(3) || receipt["configurationId"] != configurationID || receipt["agentId"] != testAgentID || receipt["namespaceId"] != testNamespaceID || receipt["createdAt"] != "2026-10-30T00:00:00.000Z" {
				t.Fatalf("receipt = %s", stdout)
			}
			if strings.Contains(stderr, "No matching admission") {
				t.Fatalf("receipt reported as a miss: %s", stderr)
			}
		})
	}
}

func TestFirstDeploymentLostResponsePrintsExactRecoveryCommand(t *testing.T) {
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		// Simulate a missing HTTP reply, not server admission. The API integration
		// test drops a real accepted reply after the regular workflow commits.
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = connection.Close()
	}))
	defer server.Close()
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "operator's $(printf injected) key.json")
	caBundle := filepath.Join(dir, "operator's $(printf injected) ca.pem")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"private-test-credential"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(caBundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	configurationID := "cfg_55555555-5555-4555-8555-555555555555"
	var out, notices bytes.Buffer
	command := New(&out, &notices)
	command.SetArgs([]string{"--url", server.URL, "--service-key-file", keyFile, "--ca-bundle", caBundle, "--timeout-seconds", "17", "--namespace", testNamespaceID, "agent", "deploy-first", testAgentID, "--key", "review-1", "--configuration", configurationID, "--generation", "3"})
	err := command.Execute()
	if !errors.Is(err, io.EOF) {
		t.Fatalf("lost original transport cause: %v", err)
	}
	if calls != 1 || out.Len() != 0 {
		t.Fatalf("requests = %d, stdout = %q; no request or receipt may be invented", calls, out.String())
	}
	if !strings.Contains(notices.String(), "same caller") || strings.Contains(notices.String(), "private-test-credential") {
		t.Fatalf("missing caller reminder or leaked credential: %s", notices.String())
	}
	lines := strings.Split(strings.TrimSpace(notices.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "outcome is unconfirmed") {
		t.Fatalf("missing recovery guidance: %s", notices.String())
	}
	// Parse the displayed command with a real POSIX shell, without executing occ.
	// Paths with quotes and command substitutions must remain literal arguments.
	parsed, err := exec.Command("sh", "-c", `occ() { printf '%s\0' "$@"; }; `+lines[1]).Output()
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSuffix(string(parsed), "\x00"), "\x00")
	want := []string{"--url", server.URL, "--service-key-file", keyFile, "--ca-bundle", caBundle, "--timeout-seconds", "17", "--namespace", testNamespaceID, "agent", "recover-first-deployment", testAgentID, "--key", "review-1", "--configuration", configurationID, "--generation", "3"}
	if !slices.Equal(got, want) {
		t.Fatalf("recovery arguments = %q, want %q", got, want)
	}
}

func TestFirstDeploymentRecoveryGuidanceDistinguishesRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		hint   bool
	}{
		{"malformed accepted reply", http.StatusAccepted, `{`, true},
		{"unavailable", http.StatusServiceUnavailable, `{"error":{"code":"UNAVAILABLE","message":"unavailable"}}`, true},
		{"request timeout", http.StatusRequestTimeout, ``, true},
		{"forbidden", http.StatusForbidden, `{"error":{"code":"FORBIDDEN","message":"The operation is not permitted."}}`, false},
		{"precondition", http.StatusConflict, `{"error":{"code":"FIRST_DEPLOYMENT_PRECONDITION_FAILED","message":"review configuration"}}`, false},
		{"unsupported server", http.StatusNotFound, ``, false},
		{"redirect", http.StatusTemporaryRedirect, ``, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			out, notices, err := runOCCAgainst(t, handler, "--ca-bundle=", "--namespace", testNamespaceID, "agent", "deploy-first", testAgentID, "--key", "review-1", "--configuration", "cfg_55555555-5555-4555-8555-555555555555", "--generation", "1")
			if err == nil || calls != 1 || out != "" {
				t.Fatalf("err = %v, requests = %d, stdout = %q", err, calls, out)
			}
			if strings.Contains(notices, "agent recover-first-deployment") != tc.hint {
				t.Fatalf("recovery hint = %q, want present = %t", notices, tc.hint)
			}
			if tc.hint && !strings.Contains(notices, "--ca-bundle ''") {
				t.Fatalf("recovery command must preserve explicit empty trust setting: %s", notices)
			}
		})
	}
}

func TestFirstDeploymentDoesNotFallBackOnOlderServer(t *testing.T) {
	_, _, requests, err := runOCCWithNotices(t, map[string]string{}, "--namespace", testNamespaceID, "agent", "deploy-first", testAgentID, "--key", "review-1", "--configuration", "cfg_55555555-5555-4555-8555-555555555555", "--generation", "1")
	if err == nil {
		t.Fatal("older server must fail closed")
	}
	if len(requests) != 1 || !strings.HasSuffix(requests[0], "/deploy-first") {
		t.Fatalf("unexpected fallback: %v", requests)
	}
}

func TestFirstDeploymentRejectsUnusableReceipts(t *testing.T) {
	configurationID := "cfg_55555555-5555-4555-8555-555555555555"
	for _, command := range []string{"deploy-first", "recover-first-deployment"} {
		for _, tc := range []struct {
			name, field string
			value       any
		}{
			{"empty", "", nil},
			{"revision ID", "revisionId", "unusable-private-receipt"},
			{"timestamp", "createdAt", "2026-10-30T00:00:00Z"},
			{"Namespace", "namespaceId", "ns_66666666-6666-4666-8666-666666666666"},
			{"Agent", "agentId", "agt_66666666-6666-4666-8666-666666666666"},
			{"Configuration", "configurationId", "cfg_66666666-6666-4666-8666-666666666666"},
			{"generation", "configurationGeneration", 4},
			{"additional field", "unexpected", "unusable-private-receipt"},
		} {
			t.Run(command+"/"+tc.name, func(t *testing.T) {
				receipt := map[string]any{"revisionId": testRevision1ID, "namespaceId": testNamespaceID, "agentId": testAgentID, "configurationId": configurationID, "configurationGeneration": 3, "createdAt": "2026-10-30T00:00:00.000Z"}
				if tc.field == "" {
					clear(receipt)
				} else {
					receipt[tc.field] = tc.value
				}
				calls := 0
				handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if command == "deploy-first" {
						w.WriteHeader(http.StatusAccepted)
					}
					_ = json.MarshalWrite(w, map[string]any{"data": receipt, "meta": map[string]string{"requestId": "test"}})
				})
				out, notices, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "--output", "json", "agent", command, testAgentID, "--key", "review-1", "--configuration", configurationID, "--generation", "3")
				// A readable envelope is not a receipt for the requested admission.
				// Reject it without echoing payload values or inventing another request.
				if err == nil || !strings.Contains(err.Error(), "invalid first-deployment receipt") || out != "" || calls != 1 {
					t.Fatalf("error = %v, stdout = %q, requests = %d", err, out, calls)
				}
				if strings.Contains(err.Error()+notices, "unusable-private-receipt") {
					t.Fatal("invalid receipt payload leaked")
				}
				if strings.Contains(notices, "agent recover-first-deployment") != (command == "deploy-first") {
					t.Fatalf("unexpected recovery guidance: %s", notices)
				}
			})
		}
	}
}

func TestFirstDeploymentClientRejectsDotSegmentsBeforeRequest(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(404)
	}))
	defer server.Close()
	client, err := occclient.New(occclient.Config{URL: server.URL, Timeout: time.Second, ServiceKeyFile: writeKeyFile(t, `{"data":{"key":"test-key"}}`)})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{".", "..", "a/b"} {
		intent := occclient.FirstDeploymentIntent{Key: key, ExpectedConfigurationID: "cfg_55555555-5555-4555-8555-555555555555", ExpectedGeneration: 1}
		if _, err := client.RecoverAgentFirstDeployment(testNamespaceID, testAgentID, intent); err == nil {
			t.Fatalf("accepted recovery key %q", key)
		}
		if _, err := client.DeployAgentFirst(testNamespaceID, testAgentID, intent); err == nil {
			t.Fatalf("accepted deployment key %q", key)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid keys caused %d requests", calls)
	}
}

func TestFirstDeploymentNullResponse(t *testing.T) {
	for _, command := range []string{"recover-first-deployment", "deploy-first"} {
		formats := []string{"", "json", "yaml"}
		if command == "deploy-first" {
			formats = []string{"json"}
		}
		for _, format := range formats {
			t.Run(command+"/"+format, func(t *testing.T) {
				calls := 0
				handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if command == "recover-first-deployment" && r.Method != http.MethodGet {
						t.Errorf("recovery used %s", r.Method)
					}
					w.Header().Set("Content-Type", "application/json")
					if command == "deploy-first" {
						w.WriteHeader(http.StatusAccepted)
					}
					_, _ = w.Write([]byte(`{"data":null,"meta":{"requestId":"test"}}`))
				})
				args := []string{"--namespace", testNamespaceID}
				if format != "" {
					args = append(args, "--output", format)
				}
				args = append(args, "agent", command, testAgentID, "--key", "review-1", "--configuration", "cfg_55555555-5555-4555-8555-555555555555", "--generation", "1")
				stdout, stderr, err := runOCCAgainst(t, handler, args...)
				if calls != 1 {
					t.Fatalf("requests = %d; must not retry", calls)
				}
				if command == "deploy-first" {
					if err == nil || !strings.Contains(err.Error(), "invalid") {
						t.Fatalf("null admission must be malformed: %v", err)
					}
					if strings.Contains(stderr, "No matching admission") {
						t.Fatalf("admission was reported as a lookup miss: %s", stderr)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(stderr, "No matching admission found") || !strings.Contains(stderr, "does not prove failure") {
					t.Fatalf("missing uncertainty notice: %s", stderr)
				}
				if format == "" {
					if stdout != "" {
						t.Fatalf("unexpected table: %s", stdout)
					}
				} else if strings.TrimSpace(stdout) != "null" {
					t.Fatalf("structured miss = %q", stdout)
				}
			})
		}
	}
}

func TestFirstDeploymentRecoveryMissWithClosedStderr(t *testing.T) {
	const configurationID = "cfg_55555555-5555-4555-8555-555555555555"
	path := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/deploy-first/review-1/" + configurationID + "/1"
	for _, format := range []string{"table", "json", "yaml"} {
		t.Run(format, func(t *testing.T) {
			calls := 0
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				body, err := io.ReadAll(r.Body)
				if err != nil || len(body) != 0 || r.ContentLength != 0 || r.Method != http.MethodGet || r.URL.RequestURI() != path {
					t.Errorf("recovery must be a bodyless GET to %s; got %s %s, content length %d, body length %d, read error %v", path, r.Method, r.URL.RequestURI(), r.ContentLength, len(body), err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"data":null,"meta":{"requestId":"req_00000000-0000-4000-8000-000000000001"}}`))
			}))
			t.Cleanup(server.Close)
			caBundle := filepath.Join(t.TempDir(), "ca.pem")
			if err := os.WriteFile(caBundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
				t.Fatal(err)
			}
			keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
			reader, stderr := io.Pipe()
			defer stderr.Close()
			if err := reader.Close(); err != nil {
				t.Fatal(err)
			}

			var stdout bytes.Buffer
			command := New(&stdout, stderr)
			command.SetArgs([]string{"--url", server.URL, "--service-key-file", keyFile, "--ca-bundle", caBundle, "--namespace", testNamespaceID, "--output", format, "agent", "recover-first-deployment", testAgentID, "--key", "review-1", "--configuration", configurationID, "--generation", "1"})
			err := command.Execute()
			server.Close()
			if calls != 1 {
				t.Fatalf("requests = %d; recovery must make exactly one GET", calls)
			}
			if format == "table" {
				if stdout.Len() != 0 {
					t.Fatalf("unexpected table output: %q", stdout.String())
				}
				if !errors.Is(err, io.ErrClosedPipe) {
					t.Fatalf("table recovery returned %v; want closed stderr pipe error", err)
				}
				if !strings.HasPrefix(err.Error(), "write first-deployment recovery notice to stderr: ") {
					t.Fatalf("table recovery error lacks notice write context: %v", err)
				}
				if !strings.Contains(err.Error(), "restore stderr and repeat this recover-first-deployment command") {
					t.Fatalf("table recovery error lacks read-only retry guidance: %v", err)
				}
			} else if err != nil || stdout.String() != "null\n" {
				t.Fatalf("%s recovery with closed stderr: stdout = %q, err = %v; want null and success", format, stdout.String(), err)
			}
		})
	}
}

func TestFirstDeploymentIntentValidationBeforeClientConstruction(t *testing.T) {
	for _, command := range []string{"deploy-first", "recover-first-deployment"} {
		for _, invalid := range []struct{ key, configuration, generation, field string }{
			{"review-1", "cfg_55555555-5555-4555-8555-555555555555", "0", "--generation"},
			{"review-1", "cfg_55555555-5555-4555-8555-555555555555", "9007199254740992", "--generation"},
			{"..", "cfg_55555555-5555-4555-8555-555555555555", "1", "--key"},
			{"review-1", "wrong", "1", "--configuration"},
		} {
			_, _, requests, err := runOCCWithNotices(t, map[string]string{}, "--url", ":invalid-url", "--namespace", testNamespaceID, "agent", command, testAgentID, "--key", invalid.key, "--configuration", invalid.configuration, "--generation", invalid.generation)
			if err == nil || !strings.Contains(err.Error(), invalid.field) || len(requests) != 0 {
				t.Fatalf("%s validation: error=%v requests=%v", invalid.field, err, requests)
			}
		}
	}
}

func TestFirstDeploymentClientGenerationBoundary(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/9007199254740991") || r.ContentLength > 0 {
			t.Errorf("unexpected recovery: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":null,"meta":{"requestId":"test"}}`))
	}))
	defer server.Close()
	client, err := occclient.New(occclient.Config{URL: server.URL, Timeout: time.Second, ServiceKeyFile: writeKeyFile(t, `{"data":{"key":"test-key"}}`)})
	if err != nil {
		t.Fatal(err)
	}
	intent := occclient.FirstDeploymentIntent{Key: "review-1", ExpectedConfigurationID: "cfg_55555555-5555-4555-8555-555555555555", ExpectedGeneration: 9007199254740991}
	if receipt, err := client.RecoverAgentFirstDeployment(testNamespaceID, testAgentID, intent); err != nil || receipt != nil {
		t.Fatalf("maximum generation: %v %v", receipt, err)
	}
	for _, generation := range []int64{0, -1, 9007199254740992} {
		intent.ExpectedGeneration = generation
		for _, call := range []func(string, string, occclient.FirstDeploymentIntent) (any, error){client.DeployAgentFirst, client.RecoverAgentFirstDeployment} {
			if _, err := call(testNamespaceID, testAgentID, intent); err == nil || !strings.Contains(err.Error(), "--generation") {
				t.Fatalf("accepted invalid generation %d: %v", generation, err)
			}
		}
	}
	if calls != 1 {
		t.Fatalf("requests = %d", calls)
	}
}

func TestFirstDeploymentCLICanonicalDecimal(t *testing.T) {
	for _, command := range []string{"deploy-first", "recover-first-deployment"} {
		for _, generation := range []string{"01", "010", "08", "0x10", "10"} {
			t.Run(command+"/"+generation, func(t *testing.T) {
				calls := 0
				handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if command == "deploy-first" {
						var body occclient.FirstDeploymentIntent
						if err := json.UnmarshalRead(r.Body, &body); err != nil {
							t.Fatal(err)
						}
						if r.Method != http.MethodPost || body.ExpectedGeneration != 10 {
							t.Errorf("unexpected POST: %s %+v", r.Method, body)
						}
					} else if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/10") {
						t.Errorf("unexpected GET: %s %s", r.Method, r.URL.Path)
					}
					w.Header().Set("Content-Type", "application/json")
					if command == "deploy-first" {
						w.WriteHeader(http.StatusAccepted)
					}
					_, _ = w.Write([]byte(`{"data":{"revisionId":"` + testRevision1ID + `","namespaceId":"` + testNamespaceID + `","agentId":"` + testAgentID + `","configurationId":"cfg_55555555-5555-4555-8555-555555555555","configurationGeneration":10,"createdAt":"2026-10-30T00:00:00.000Z"},"meta":{"requestId":"test"}}`))
				})
				_, _, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", command, testAgentID, "--key", "review-1", "--configuration", "cfg_55555555-5555-4555-8555-555555555555", "--generation", generation)
				if generation == "10" {
					if err != nil || calls != 1 {
						t.Fatalf("decimal control: err=%v calls=%d", err, calls)
					}
				} else if err == nil || !strings.Contains(err.Error(), "--generation") || calls != 0 {
					t.Fatalf("noncanonical %s: err=%v calls=%d", generation, err, calls)
				}
			})
		}
	}
}

func TestDeployRetainsRequestedOverridesInsteadOfResolvedDefaults(t *testing.T) {
	base := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	var calls []string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		var data any
		switch r.Method + " " + r.URL.Path {
		case "GET " + base + "/revisions/" + testRevision1ID:
			// The old revision inherited a default. Retaining its request must send {},
			// so an upgrade can resolve the current default instead of inventing an override.
			data = map[string]any{
				"id": testRevision1ID, "namespaceId": testNamespaceID, "agentId": testAgentID,
				"revision": 1, "backendId": nil, "configurationId": "cfg_55555555-5555-4555-8555-555555555555",
				"configurationKind": "agent", "configurationGeneration": 1, "gatewayManagedMode": false,
				"configuration": map[string]any{"agents": map[string]any{"defaults": map[string]any{"model": "codex/gpt-5"}}},
				"harness": map[string]any{"id": "codex", "version": "fixture", "mode": "dedicated", "overrides": map[string]any{},
					"configuration": map[string]any{"modelProvider": map[string]any{"protocol": "openai-responses", "baseUrl": "https://previous.example.com/v1", "supportsStandaloneWebSearch": false}}},
				"compute":     map[string]any{"id": "kubernetes", "implementation": "kubernetes"},
				"harnessAuth": map[string]any{"method": "api_key", "source": map[string]any{"kind": "secret", "namespaceId": testNamespaceID, "id": "sec_44444444-4444-4444-8444-444444444444"}},
				"createdAt":   "2026-11-06T00:00:00.000Z",
			}
		case "POST " + base + "/deploy":
			var body map[string]any
			if err := json.UnmarshalRead(r.Body, &body); err != nil {
				t.Fatal(err)
			}
			overrides, ok := body["harnessOverrides"].(map[string]any)
			if !ok || len(overrides) != 0 {
				t.Errorf("expected retained empty overrides, got %#v", body)
			}
			w.WriteHeader(http.StatusAccepted)
			data = map[string]any{"id": testRevision2ID, "revision": 2, "agentId": testAgentID, "configurationId": "cfg_55555555-5555-4555-8555-555555555555"}
		case "GET " + base + "/deployments/" + testRevision2ID:
			data = map[string]any{"deploymentId": testRevision2ID, "namespaceId": testNamespaceID, "agentId": testAgentID, "status": "queued"}
		default:
			t.Errorf("unexpected operation: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if err := json.MarshalWrite(w, map[string]any{"data": data, "meta": map[string]any{"requestId": "test"}}); err != nil {
			t.Fatal(err)
		}
	})
	out, notices, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", "deploy", testAgentID, "--retain-harness-overrides", testRevision1ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, testRevision2ID) || notices != "" {
		t.Fatalf("wrong deployment receipt: %s %s", notices, out)
	}
	want := []string{"GET " + base + "/revisions/" + testRevision1ID, "POST " + base + "/deploy", "GET " + base + "/deployments/" + testRevision2ID}
	if !slices.Equal(calls, want) {
		t.Fatalf("operations = %v", calls)
	}
}
