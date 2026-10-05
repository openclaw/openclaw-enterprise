package occcli

import (
	"bytes"
	"encoding/json/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
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
}

func (fake *fakeOCC) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	key := request.Method + " " + request.URL.Path
	fake.mu.Lock()
	fake.requested = append(fake.requested, key)
	fake.mu.Unlock()
	data, ok := fake.responses[key]
	if !ok {
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"not found"}}`))
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
	fake := &fakeOCC{responses: responses}
	server := httptest.NewServer(fake)
	defer server.Close()
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	command := New(&out, &bytes.Buffer{})
	command.SetArgs(append([]string{"--url", server.URL, "--service-key-file", keyFile}, args...))
	err := command.Execute()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return out.String(), append([]string(nil), fake.requested...), err
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

func TestResourceCommandsRejectNamesWithAHintBeforeCallingOCC(t *testing.T) {
	cases := []struct {
		args []string
		hint string
	}{
		{[]string{"--namespace", testNamespaceID, "agent", "get", "dogfood-agent"}, "occ agent list"},
		{[]string{"--namespace", "default", "agent", "list"}, "occ namespace list"},
		{[]string{"namespace", "get", "default"}, "occ namespace list"},
		{[]string{"--namespace", testNamespaceID, "secret", "get", "model-key"}, "occ secret list"},
		{[]string{"--namespace", testNamespaceID, "preset", "delete", "default-codex"}, "occ preset list"},
		{[]string{"--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, "1"}, "occ agent revisions"},
		{[]string{"--namespace", testNamespaceID, "credential-source", "update", "openai"}, "occ credential-source list"},
		{[]string{"--namespace", testNamespaceID, "agent", "credential-withdrawal", "request", "dogfood-agent", "cs_1"}, "occ agent list"},
		{[]string{"--namespace", testNamespaceID, "agent", "credential-withdrawal", "get", testAgentID, "openai"}, "occ credential-source list"},
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

func TestDeploymentStatusWithoutRevisionsExplainsHowToDeploy(t *testing.T) {
	_, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/revisions": `[]`,
	}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	if err == nil || !strings.Contains(err.Error(), "occ agent deploy") {
		t.Fatalf("expected a deploy hint, got %v", err)
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
