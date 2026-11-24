package occcli

import (
	"encoding/json/v2"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDeployRejectsInvalidRetainedHarnessRevisionBeforeRequest(t *testing.T) {
	for _, test := range []struct {
		name string
		id   string
	}{
		{name: "malformed revision", id: "rev_bad"},
		{name: "wrong ID kind", id: testAgentID},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				http.NotFound(w, r)
			})
			want := revisionIDArg.check(test.id, testNamespaceID)
			_, _, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", "deploy", testAgentID, "--retain-harness-overrides", test.id)
			if err == nil || err.Error() != want.Error() || calls.Load() != 0 {
				t.Fatalf("error = %v, requests = %d; want error %q and zero requests", err, calls.Load(), want)
			}
		})
	}
}

func TestAgentRevisionChecksRetainedHarnessOverrides(t *testing.T) {
	base := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/revisions"
	exact := base + "/" + testRevision1ID
	identity := fmt.Sprintf(`"id":%q,"namespaceId":%q,"agentId":%q`, testRevision1ID, testNamespaceID, testAgentID)
	unreadable := `{` + identity + `,"revision":1,"configurationReadError":{"code":"SAVED_CONFIGURATION_UNREADABLE","field":"harnessAuth"}}`
	descriptor := `"id":"codex","version":"fixture","mode":"dedicated"`
	override := `{"modelProvider":{"protocol":"openai-responses","baseUrl":"https://retained.example.com/v1"}}`
	readable := func(harness string) string {
		return `{` + identity + `,"revision":1,"harness":{` + descriptor + harness + `}}`
	}
	summaryPage := func(fields string) string {
		return `[{` + identity + `,"revision":1` + fields + `}]`
	}
	receipt := map[string]any{
		"agentId": testAgentID, "id": testRevision1ID, "namespaceId": testNamespaceID,
		"canRetainHarnessOverrides": true,
	}
	denied := `raw:403 {"error":{"code":"FORBIDDEN","message":"revision read denied"}}`
	for _, test := range []struct {
		name      string
		revision  string
		summaries string
		refusal   string
	}{
		{name: "requested overrides", revision: readable(`,"overrides":` + override)},
		{name: "explicit empty overrides", revision: readable(`,"overrides":{}`)},
		{name: "missing overrides", revision: readable(""), refusal: "no requested Harness overrides"},
		{name: "null overrides", revision: readable(`,"overrides":null`), refusal: "no requested Harness overrides"},
		{name: "array overrides", revision: readable(`,"overrides":[]`), refusal: "no requested Harness overrides"},
		{name: "different revision", revision: strings.Replace(readable(`,"overrides":{}`), testRevision1ID, testRevision2ID, 1), refusal: "does not match"},
		{name: "different namespace", revision: strings.Replace(readable(`,"overrides":{}`), testNamespaceID, "ns_00000000-0000-4000-8000-000000000001", 1), refusal: "does not match"},
		{name: "different Agent", revision: strings.Replace(readable(`,"overrides":{}`), testAgentID, "agt_00000000-0000-4000-8000-000000000001", 1), refusal: "does not match"},
		{name: "non-object revision", revision: "null", refusal: "revision is unavailable"},
		{name: "legacy recorded overrides", revision: unreadable, summaries: summaryPage(`,"harness":{` + descriptor + `,"overrides":` + override + `}`)},
		{name: "legacy descriptor certifies no overrides", revision: unreadable, summaries: summaryPage(`,"harness":{` + descriptor + `}`)},
		{name: "legacy no Harness evidence", revision: unreadable, summaries: summaryPage(""), refusal: "no Harness summary"},
		{name: "legacy malformed overrides", revision: unreadable, summaries: summaryPage(`,"harness":{` + descriptor + `,"overrides":null}`), refusal: "invalid recorded Harness overrides"},
		{name: "legacy different revision", revision: unreadable, summaries: strings.Replace(summaryPage(`,"harness":{`+descriptor+`}`), testRevision1ID, testRevision2ID, 1), refusal: "no Harness summary"},
		{name: "legacy summary different Agent", revision: unreadable, summaries: strings.Replace(summaryPage(`,"harness":{`+descriptor+`}`), testAgentID, "agt_00000000-0000-4000-8000-000000000001", 1), refusal: "does not match"},
		{name: "denied exact read", revision: denied, refusal: "revision read denied"},
		{name: "denied list read", revision: unreadable, summaries: denied, refusal: "revision read denied"},
	} {
		t.Run(test.name, func(t *testing.T) {
			responses := map[string]string{"GET " + exact: test.revision}
			want := []string{"GET " + exact}
			if test.summaries != "" {
				responses["GET "+base] = test.summaries
				want = append(want, "GET "+base+"?limit=100")
			}
			out, notices, calls, err := runOCCWithNotices(t, responses, "--namespace", testNamespaceID, "--output", "json", "agent", "revision", testAgentID, testRevision1ID, "--check-retain-harness-overrides")
			if test.refusal != "" {
				if err == nil || !strings.Contains(err.Error(), test.refusal) || out != "" {
					t.Fatalf("error = %v and stdout = %q, want %q and empty stdout", err, out, test.refusal)
				}
			} else {
				var result map[string]any
				if err != nil || json.Unmarshal([]byte(out), &result) != nil || !maps.Equal(result, receipt) || notices != "" {
					t.Fatalf("error = %v, notice = %q and stdout = %q, want only receipt %v", err, notices, out, receipt)
				}
			}
			if !slices.Equal(calls, want) {
				t.Fatalf("requests = %v, want %v", calls, want)
			}
		})
	}
}
