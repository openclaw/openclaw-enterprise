package occcli

import (
	"bytes"
	"encoding/json/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

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
	server := httptest.NewServer(fake)
	defer server.Close()
	keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
	var out, errOut bytes.Buffer
	command := New(&out, &errOut)
	command.SetArgs(append([]string{"--url", server.URL, "--service-key-file", keyFile}, args...))
	err := command.Execute()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return out.String(), errOut.String(), append([]string(nil), fake.requested...), err
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
		{"odd revision", `{"status":"observed","revisionId":"rev_1 --source gateway","harness":{"state":"starting","code":"HARNESS_RESTARTING","exitCode":1,"restarts":2}}`, "Harness Sandbox: starting (HARNESS_RESTARTING, last exit code 1, restart 2). The Harness process exited and OpenShell is restarting it; if this persists, read its Sandbox logs (occ --namespace " + testNamespaceID + " agent logs " + testAgentID + " --source sandbox)."},
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
	cases := []struct {
		args []string
		hint string
	}{
		{[]string{"--namespace", testNamespaceID, "agent", "get", "dogfood-agent"}, "occ --namespace " + testNamespaceID + " agent list"},
		{[]string{"--namespace", "default", "agent", "list"}, "occ namespace list"},
		{[]string{"namespace", "get", "default"}, "occ namespace list"},
		{[]string{"--namespace", testNamespaceID, "secret", "get", "model-key"}, "occ --namespace " + testNamespaceID + " secret list"},
		{[]string{"--namespace", testNamespaceID, "preset", "delete", "default-codex"}, "occ --namespace " + testNamespaceID + " preset list"},
		{[]string{"--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, "1"}, "occ --namespace " + testNamespaceID + " agent revisions"},
		{[]string{"--namespace", testNamespaceID, "credential-source", "update", "openai"}, "occ --namespace " + testNamespaceID + " credential-source list"},
		{[]string{"--namespace", testNamespaceID, "service-account", "delete", "--force", "ci-bot"}, "occ --namespace " + testNamespaceID + " service-account list"},
		{[]string{"--namespace", testNamespaceID, "agent", "credential-withdrawal", "request", "dogfood-agent", "cs_1"}, "occ --namespace " + testNamespaceID + " agent list"},
		{[]string{"--namespace", testNamespaceID, "agent", "credential-withdrawal", "get", testAgentID, "openai"}, "occ --namespace " + testNamespaceID + " credential-source list"},
	}
	for _, testCase := range cases {
		_, requested, err := runOCC(t, map[string]string{}, testCase.args...)
		if err == nil || !strings.Contains(err.Error(), testCase.hint) {
			t.Errorf("%v: expected an error pointing at %q, got %v", testCase.args, testCase.hint, err)
		}
		if len(requested) != 0 {
			t.Errorf("%v: expected no request, got %v", testCase.args, requested)
		}
	}
}

func TestIDHintsKeepTheSelectedNamespace(t *testing.T) {
	// A stale environment scope must not replace the explicitly selected Namespace in the hint.
	t.Setenv("OCC_NAMESPACE", "ns_55555555-5555-4555-8555-555555555555")
	cases := []struct {
		args []string
		want string
	}{
		{
			[]string{"--namespace", testNamespaceID, "agent", "get", "dogfood-agent"},
			`"dogfood-agent" is not a valid Agent ID: OCC accepts IDs that start with "agt_", not names; run "occ --namespace ` + testNamespaceID + ` agent list" to find the ID`,
		},
		{
			[]string{"--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, "1"},
			`"1" is not a valid deployment ID: OCC accepts IDs that start with "rev_", not names; run "occ --namespace ` + testNamespaceID + ` agent revisions AGENT_ID" to find the ID`,
		},
		{
			[]string{"--namespace", testNamespaceID, "agent", "logs", testAgentID, "--source", "gateway", "--revision", "1"},
			`"1" is not a valid deployment ID: OCC accepts IDs that start with "rev_", not names; run "occ --namespace ` + testNamespaceID + ` agent revisions AGENT_ID" to find the ID`,
		},
		{
			[]string{"--namespace", testNamespaceID, "configuration", "get", "base"},
			`"base" is not a valid Configuration ID: OCC accepts IDs that start with "cfg_", not names; run "occ --namespace ` + testNamespaceID + ` agent get AGENT_ID" to find the ID`,
		},
		{
			[]string{"--namespace", testNamespaceID, "secret", "get", "model-key"},
			`"model-key" is not a valid Secret ID: OCC accepts IDs that start with "sec_", not names; run "occ --namespace ` + testNamespaceID + ` secret list" to find the ID`,
		},
		// Namespaces are not Namespace-scoped, and a selection that is not a
		// Namespace ID is left out rather than repeated into the hint.
		{
			[]string{"--namespace", testNamespaceID, "namespace", "get", "default"},
			`"default" is not a valid Namespace ID: OCC accepts IDs that start with "ns_", not names; run "occ namespace list" to find the ID`,
		},
		{
			[]string{"--namespace", "default", "agent", "get", "dogfood-agent"},
			`"dogfood-agent" is not a valid Agent ID: OCC accepts IDs that start with "agt_", not names; run "occ agent list" to find the ID`,
		},
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
	want := `"dogfood-agent" is not a valid Agent ID: OCC accepts IDs that start with "agt_", not names; run "occ --namespace ` + testNamespaceID + ` agent list" to find the ID`
	if err == nil || err.Error() != want {
		t.Errorf("error = %v, want %q", err, want)
	}
	if len(requested) != 0 {
		t.Errorf("expected no request, got %v", requested)
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

func agentRevisionsResponse() string {
	return `[{"id":"` + testRevision2ID + `","revision":2,"agentId":"` + testAgentID + `","configurationGeneration":2,"createdAt":"2026-09-30T01:00:00.000Z"},` +
		`{"id":"` + testRevision1ID + `","revision":1,"agentId":"` + testAgentID + `","configurationGeneration":1,"createdAt":"2026-09-30T00:00:00.000Z"}]`
}

// agentRevisionResponses serves an Agent whose active revision is revision 1,
// a failed revision 2, and the revision list.
func agentRevisionResponses() map[string]string {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	return map[string]string{
		"GET " + agentPath:                                     `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision1ID + `"}`,
		"GET " + agentPath + "/revisions":                      agentRevisionsResponse(),
		"GET " + agentPath + "/deployments/" + testRevision1ID: `{"deploymentId":"` + testRevision1ID + `","status":"succeeded"}`,
		"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","status":"failed"}`,
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
		if rows[0]["active"] != false || rows[0]["deploymentStatus"] != "failed" {
			t.Fatalf("%s: revision 2 = %v", format, rows[0])
		}
		if rows[1]["active"] != true || rows[1]["deploymentStatus"] != "succeeded" {
			t.Fatalf("%s: revision 1 = %v", format, rows[1])
		}
	}
}

func TestAgentRevisionsToleratesUnreadableDeploymentStatus(t *testing.T) {
	responses := agentRevisionResponses()
	delete(responses, "GET /namespaces/"+testNamespaceID+"/agents/"+testAgentID+"/deployments/"+testRevision2ID)
	out, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "agent", "revisions", testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, testRevision2ID) || !strings.Contains(out, "succeeded") {
		t.Fatalf("expected both revisions with the readable status:\n%s", out)
	}
}

func TestDeploymentStatusDefaultsToTheLatestRevision(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	out, requested, err := runOCC(t, map[string]string{
		"GET " + agentPath:                `{"id":"` + testAgentID + `","activeRevisionId":"` + testRevision2ID + `"}`,
		"GET " + agentPath + "/revisions": agentRevisionsResponse(),
		"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","agentId":"` + testAgentID +
			`","namespaceId":"` + testNamespaceID + `","status":"failed","error":{"code":"CONVERGENCE_DEADLINE_EXCEEDED","message":"Deployment did not converge."}}`,
	}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
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
	want := "agent " + testAgentID + " has no revision you can read; listing revisions needs revision read (ask an administrator to grant it)"
	if err == nil || err.Error() != want {
		t.Fatalf("reader error = %v, want %q", err, want)
	}
}

// Go maps have no order, so JSON output must sort object keys (as YAML does) to be
// diffable from run to run, including nested objects in table cells.
func TestJSONOutputAndTableCellsKeepAStableKeyOrder(t *testing.T) {
	responses := map[string]string{
		"GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID: `{"status":"active","name":"a","id":"` + testAgentID + `","executionMode":"embedded","desiredRuntimeState":"running","createdAt":"2026-09-30T00:00:00.000Z","configurationId":"cfg_1","activeRevisionId":"rev_1","servicePrincipalId":"sp_1"}`,
		"GET /namespaces/" + testNamespaceID + "/iam/roles/role_1":      `{"id":"role_1","permissions":[{"resourceKind":"agent","action":"read"}]}`,
	}
	want := `{
  "activeRevisionId": "rev_1",
  "configurationId": "cfg_1",
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

// List items are summaries, so a revision whose saved settings are unreadable is
// found only when its deployment status read fails (503). The listing keeps the
// other revisions' status and names the unreadable one instead of failing.
func TestAgentRevisionBrowsingKeepsHealthyStatusBesideUnreadableSnapshot(t *testing.T) {
	responses := agentRevisionResponses()
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses["GET "+agentPath+"/deployments/"+testRevision2ID] = `raw:503 {"error":{"code":"DEPENDENCY_UNAVAILABLE","message":"Persisted AgentRevision plugin state is invalid."}}`
	for _, format := range []string{"table", "json", "yaml"} {
		out, notices, _, err := runOCCWithNotices(t, responses, "--namespace", testNamespaceID, "--output", format, "agent", "revisions", testAgentID)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, testRevision2ID) || !strings.Contains(out, "succeeded") {
			t.Fatalf("%s must list both revisions and the healthy status: %s", format, out)
		}
		if !strings.Contains(notices, "deployment status of revision "+testRevision2ID+" is unavailable") {
			t.Fatalf("%s must name the revision whose status is unavailable: %q", format, notices)
		}
	}
}

// The revisions command shows one page; it passes --limit and --cursor through
// and prints how to read the next page.
func TestAgentRevisionsPagesWithCursor(t *testing.T) {
	// A stale environment scope must not replace the explicitly selected Namespace.
	t.Setenv("OCC_NAMESPACE", "ns_55555555-5555-4555-8555-555555555555")
	responses := agentRevisionResponses()
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	responses["GET "+agentPath+"/revisions"] = `raw:200 {"data":[{"id":"` + testRevision2ID + `","revision":2,"createdAt":"2026-09-30T01:00:00.000Z"}],"meta":{"requestId":"req_test","nextCursor":"v1.2"}}`
	out, notices, requested, err := runOCCWithNotices(t, responses, "--namespace", testNamespaceID, "agent", "revisions", testAgentID, "--limit", "1", "--cursor", "v1.3")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(requested, "GET "+agentPath+"/revisions?cursor=v1.3&limit=1") {
		t.Fatalf("limit and cursor must reach OCC: %v", requested)
	}
	if !strings.Contains(out, testRevision2ID) || strings.Contains(out, testRevision1ID) {
		t.Fatalf("expected only the page's revision:\n%s", out)
	}
	if !strings.Contains(notices, "agent revisions "+testAgentID+" --limit 1 --cursor v1.2") {
		t.Fatalf("expected a next-page hint that keeps --limit: %q", notices)
	}
	_, continuation, found := strings.Cut(notices, `older revisions may exist; run "`)
	if !found {
		t.Fatalf("missing next-page command: %q", notices)
	}
	continuation, _, _ = strings.Cut(continuation, `"`)
	responses["GET "+agentPath+"/revisions"] = `raw:200 {"data":[{"id":"` + testRevision1ID + `","revision":1,"createdAt":"2026-09-30T00:00:00.000Z"}],"meta":{"requestId":"req_test","nextCursor":null}}`
	nextOut, nextRequested, err := runOCC(t, responses, strings.Fields(continuation)[1:]...)
	if err != nil {
		t.Fatalf("advertised next-page command failed: %v", err)
	}
	if !slices.Contains(nextRequested, "GET "+agentPath+"/revisions?cursor=v1.2&limit=1") || !strings.Contains(nextOut, testRevision1ID) {
		t.Fatalf("next-page command lost the selected Namespace, limit, or cursor: %v\n%s", nextRequested, nextOut)
	}
	for _, limit := range []string{"0", "101"} {
		if _, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "agent", "revisions", testAgentID, "--limit", limit); err == nil {
			t.Fatalf("--limit %s must be refused locally", limit)
		}
	}
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
