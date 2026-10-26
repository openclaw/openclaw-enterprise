package occcli

import (
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"maps"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// Every command that sends an OCC request has a hint entry, and no entry names
// a command that no longer exists.
func TestRefusalHintTableCoversEveryCommand(t *testing.T) {
	root := New(&bytes.Buffer{}, &bytes.Buffer{})
	commands := map[string]bool{}
	var walk func(*cobra.Command)
	walk = func(command *cobra.Command) {
		for _, child := range command.Commands() {
			switch child.Name() {
			case "help", "completion", "dev":
				// Local commands: they send no OCC request.
				continue
			}
			if child.HasSubCommands() {
				walk(child)
			} else if child.Runnable() {
				commands[strings.TrimPrefix(child.CommandPath(), "occ ")] = true
				if child.RunE == nil {
					// addRefusalHints wraps RunE only.
					t.Errorf("%s has no RunE, so a refusal gets no hint", child.CommandPath())
				}
			}
		}
	}
	walk(root)
	for _, path := range slices.Sorted(maps.Keys(commands)) {
		if _, ok := commandPermissions[path]; !ok {
			t.Errorf("occ %s has no commandPermissions entry", path)
		}
	}
	for _, path := range slices.Sorted(maps.Keys(commandPermissions)) {
		if !commands[path] {
			t.Errorf("commandPermissions names occ %s, which is not a command", path)
		}
	}
}

// Each entry's permissions are exactly the unconditional ones the API contract
// declares for its operations, so the hint cannot drift from the server.
func TestRefusalHintTableMatchesTheAPIContract(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "packages", "contracts", "openapi", "occ-api.openapi.json"))
	if err != nil {
		t.Fatal(err)
	}
	type permission struct {
		Action       string `json:"action"`
		ResourceKind string `json:"resourceKind"`
		Scope        string `json:"scope"`
		Condition    string `json:"condition"`
	}
	var document struct {
		Paths map[string]map[string]jsontext.Value `json:"paths"`
	}
	if err := json.Unmarshal(contents, &document); err != nil {
		t.Fatal(err)
	}
	operations := map[string][]permission{}
	for _, methods := range document.Paths {
		for _, raw := range methods {
			var operation struct {
				OperationID string       `json:"operationId"`
				Permissions []permission `json:"x-openclaw-permissions"`
			}
			if json.Unmarshal(raw, &operation) == nil && operation.OperationID != "" {
				operations[operation.OperationID] = operation.Permissions
			}
		}
	}
	for path, entry := range commandPermissions {
		required := map[string]bool{}
		for _, operationID := range entry.operations {
			permissions, ok := operations[operationID]
			if !ok {
				t.Errorf("occ %s: no operation %s in the API contract", path, operationID)
			}
			for _, permission := range permissions {
				// each_returned filters a list; conditional grants go in also.
				if permission.Condition == "" && permission.Scope != "each_returned" {
					required[permission.ResourceKind+"."+permission.Action] = true
				}
			}
		}
		needs := slices.Sorted(slices.Values(entry.needs))
		if want := slices.Sorted(maps.Keys(required)); !slices.Equal(needs, want) {
			t.Errorf("occ %s needs %v, API contract requires %v", path, needs, want)
		}
		for _, need := range entry.needs {
			if kind, _, _ := strings.Cut(need, "."); permissionKinds[kind] == "" {
				t.Errorf("occ %s: no display name for resource kind %q", path, kind)
			}
		}
	}
}

func runRefused(t *testing.T, keyFile string, message string, args ...string) error {
	t.Helper()
	server := httptest.NewServer(&fakeOCC{responses: map[string]string{}, refuse: message})
	defer server.Close()
	command := New(&bytes.Buffer{}, &bytes.Buffer{})
	command.SetArgs(append([]string{"--url", server.URL, "--service-key-file", keyFile}, args...))
	return command.Execute()
}

func writeKeyFile(t *testing.T, contents string) string {
	t.Helper()
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return keyFile
}

// D609: a refusal names what the command needs and whom to ask, and prints the
// same text for a real and a fake ID, so the hint is no existence oracle.
func TestRefusedCommandsNameTheGrantTheyNeed(t *testing.T) {
	keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
	const denied = "The exact platform operation was not authorized."
	var texts []string
	for _, agentID := range []string{testAgentID, "agt_00000000-0000-4000-8000-000000000000"} {
		err := runRefused(t, keyFile, denied, "--namespace", testNamespaceID, "agent", "deploy", agentID)
		if err == nil {
			t.Fatal("deploy was not refused")
		}
		texts = append(texts, err.Error())
	}
	want := "FORBIDDEN: " + denied + "\n" +
		`hint: "occ agent deploy" needs Agent deploy and Configuration read, plus access to the ServiceAccount, Secrets and credential sources it binds, and Agent read and operate for a first deploy; ask an Installation administrator to grant what is missing. OCC refuses an ID that does not exist the same way.`
	if !strings.HasSuffix(texts[0], want) || texts[0] != texts[1] {
		t.Fatalf("refusals = %q, want both to end with %q", texts, want)
	}
	err := runRefused(t, keyFile, denied, "--namespace", testNamespaceID, "agent", "logs", testAgentID, "--source", "gateway", "--revision", testRevision1ID)
	if err == nil || !strings.HasSuffix(err.Error(), `hint: "occ agent logs" needs Agent read_logs (or administer) and Agent read; ask an Installation administrator to grant what is missing. OCC refuses an ID that does not exist the same way.`) {
		t.Fatalf("logs refusal = %v", err)
	}
	// A command without an ID argument does not mention missing IDs.
	err = runRefused(t, keyFile, denied, "--namespace", testNamespaceID, "iam", "role", "list")
	if err == nil || !strings.HasSuffix(err.Error(), `hint: "occ iam role list" needs Installation administer and Namespace read; ask an Installation administrator to grant what is missing.`) {
		t.Fatalf("role list refusal = %v", err)
	}
	// Three or more permissions read as a list.
	err = runRefused(t, keyFile, denied, "--namespace", testNamespaceID, "agent", "runtime", testAgentID)
	if err == nil || !strings.HasSuffix(err.Error(), `hint: "occ agent runtime" needs Agent operate, Agent read and revision read; ask an Installation administrator to grant what is missing. OCC refuses an ID that does not exist the same way.`) {
		t.Fatalf("runtime refusal = %v", err)
	}
	// OCC filters this list by what the caller can read. Keep its refusal intact;
	// the CLI cannot name a missing grant for the list itself.
	err = runRefused(t, keyFile, denied, "namespace", "list")
	if want := "OCC operation failed (HTTP 403): FORBIDDEN: " + denied; err == nil || err.Error() != want {
		t.Fatalf("namespace list refusal = %v, want %q", err, want)
	}
	// A 403 that names its own cause, such as an Agent principal's missing
	// grant or the caller's own missing grant (finding 2534), and other
	// failures ("" answers 404) keep OCC's text alone.
	for _, message := range []string{
		"The Agent principal is not authorized to operate the Secret.",
		"Not authorized: this needs Agent deploy on Agent " + testAgentID + ". Ask an Installation administrator to grant it.",
		"",
	} {
		err := runRefused(t, keyFile, message, "--namespace", testNamespaceID, "agent", "deploy", testAgentID)
		if err == nil || strings.Contains(err.Error(), "hint:") {
			t.Fatalf("refusal %q = %v, want no hint", message, err)
		}
	}
}

// A Namespace-scoped key that addresses another Namespace or an Installation
// route gets OCC's admitted-Namespace refusal; the hint names the key's own
// Namespace from the local key file, the same for any target.
func TestNamespaceKeyRefusalNamesTheKeysNamespace(t *testing.T) {
	const mismatch = "The admitted Namespace does not match."
	scoped := writeKeyFile(t, `{"data":{"key":"test-key","namespaceId":"`+testNamespaceID+`"}}`)
	want := "\nhint: this service key is scoped to Namespace " + testNamespaceID + `; it cannot reach another Namespace or Installation-level commands such as "occ namespace list". Pass --namespace ` + testNamespaceID + ` (or set OCC_NAMESPACE), read it with "occ namespace get ` + testNamespaceID + `", or use an Installation-scoped key.`
	for _, args := range [][]string{
		{"namespace", "get", "ns_00000000-0000-4000-8000-000000000000"},
		{"--namespace", "ns_00000000-0000-4000-8000-000000000000", "agent", "get", testAgentID},
	} {
		err := runRefused(t, scoped, mismatch, args...)
		if err == nil || !strings.HasSuffix(err.Error(), want) {
			t.Fatalf("occ %v refusal = %v, want suffix %q", args, err, want)
		}
	}
	// No recorded Namespace, or one that is not a plain ID, is not printed.
	for _, contents := range []string{
		`{"data":{"key":"test-key"}}`,
		`{"data":{"key":"test-key","namespaceId":"ns_00000000-0000-4000-8000-000000000001\u001b[2J"}}`,
		`{"data":{"key":"test-key","namespaceId":"\u001b[2Jns_1"}}`,
		`{"data":{"key":"test-key","namespaceId":"ns_"}}`,
		`{"data":{"key":"test-key","namespaceId":"ns_` + strings.Repeat("a", 65) + `"}}`,
		`{"data":{"key":"test-key","namespaceId":"default"}}`,
		`{"data":{"key":"test-key","namespaceId":123}}`,
	} {
		err := runRefused(t, writeKeyFile(t, contents), mismatch, "namespace", "get", "ns_00000000-0000-4000-8000-000000000000")
		if err == nil || !strings.Contains(err.Error(), "hint: this service key is scoped to one Namespace;") {
			t.Fatalf("refusal with key file %s = %v", contents, err)
		}
		err = runRefused(t, writeKeyFile(t, contents), mismatch, "namespace", "list")
		if want := "\nhint: \"occ namespace list\" needs an Installation-scoped key. This service key works only in one Namespace, so ask an Installation administrator to run it for you."; err == nil || !strings.HasSuffix(err.Error(), want) {
			t.Fatalf("refusal with key file %s = %v, want suffix %q", contents, err, want)
		}
	}
}

// Finding D740: an Installation-level command refused for a Namespace key does
// not tell the caller to pass the --namespace it already selected; it says the
// command needs an Installation-scoped key and who can run it.
func TestInstallationCommandRefusalAsksForAnInstallationKey(t *testing.T) {
	const mismatch = "The admitted Namespace does not match."
	scoped := writeKeyFile(t, `{"data":{"key":"test-key","namespaceId":"`+testNamespaceID+`"}}`)
	for _, args := range [][]string{
		{"installation", "get"},
		{"installation", "deployment-inventory"},
		{"namespace", "list"},
		{"namespace", "create", "team"},
		{"service-key", "revoke", "key-1"},
	} {
		path := strings.Join(args[:2], " ")
		want := "\nhint: \"occ " + path + "\" needs an Installation-scoped key. This service key works only in Namespace " + testNamespaceID + ` (read it with "occ namespace get ` + testNamespaceID + `"), so ask an Installation administrator to run it for you.`
		err := runRefused(t, scoped, mismatch, append([]string{"--namespace", testNamespaceID}, args...)...)
		if err == nil || !strings.HasSuffix(err.Error(), want) || strings.Contains(err.Error(), "Pass --namespace") {
			t.Fatalf("occ %v refusal = %v, want suffix %q", args, err, want)
		}
	}
}
