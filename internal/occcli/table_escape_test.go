package occcli

import (
	"strings"
	"testing"
)

// The API Name contract rejects only C0 controls and DEL, so a name can hold
// bidirectional overrides, zero-width and C1 control characters that would
// reorder or hide table columns for whoever lists the resource.
func TestTableEscapesInvisibleAndControlCharactersInCells(t *testing.T) {
	list := `[` +
		`{"id":"agt_1","name":"report\u202egnp.exe","status":"active"},` +
		`{"id":"agt_2","name":"zero\u200bwidth\u009b2J","status":"active"},` +
		`{"id":"agt_3","name":"日本語 エージェント","status":"active"},` +
		`{"id":"agt_4","name":"\"report\\u202egnp.exe\"","status":"active"}` +
		`]`
	responses := map[string]string{"GET /namespaces/" + testNamespaceID + "/agents": list}
	out, _, err := runOCC(t, responses, "--namespace", testNamespaceID, "agent", "list")
	if err != nil {
		t.Fatal(err)
	}
	// A name that only looks escaped is quoted too, so the two cannot be confused.
	for _, want := range []string{`"report\u202egnp.exe"`, `"zero\u200bwidth\u009b2J"`, "日本語 エージェント", `"\"report\\u202egnp.exe\""`} {
		if !strings.Contains(out, want) {
			t.Errorf("table lacks %s:\n%s", want, out)
		}
	}
	if strings.ContainsAny(out, "\u202e\u200b\u009b") {
		t.Errorf("table prints invisible or control characters raw:\n%q", out)
	}

	// Structured values are JSON in a cell; their escapes stay valid JSON.
	roles := `[{"id":"role_1","name":"r","permissions":[{"action":"read","resourceKind":"agent\u2066"}]}]`
	out, _, err = runOCC(t, map[string]string{"GET /namespaces/" + testNamespaceID + "/iam/roles": roles},
		"--namespace", testNamespaceID, "iam", "role", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"resourceKind":"agent\u2066"`) || strings.Contains(out, "\u2066") {
		t.Errorf("JSON cell does not escape the isolate character:\n%q", out)
	}

	// JSON output stays the exact values.
	out, _, err = runOCC(t, responses, "--namespace", testNamespaceID, "-o", "json", "agent", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "report\u202egnp.exe") {
		t.Errorf("JSON output altered the name:\n%q", out)
	}
}
