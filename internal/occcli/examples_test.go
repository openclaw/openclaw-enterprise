package occcli

import (
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

var inlineJSONObject = regexp.MustCompile(`\{".*\}`)

// exampleBody returns the JSON body in a help example: the heredoc body when
// there is one, otherwise the first inline object.
func exampleBody(example string) string {
	if start := strings.Index(example, "<<'JSON'\n"); start >= 0 {
		rest := example[start+len("<<'JSON'\n"):]
		if end := strings.Index(rest, "\nJSON\n"); end >= 0 {
			return rest[:end]
		}
		// A heredoc without its own closing line must not pass as an inline object.
		return ""
	}
	return inlineJSONObject.FindString(example)
}

func TestCreateCommandsShowAJSONExample(t *testing.T) {
	root := New(io.Discard, io.Discard)
	for _, path := range [][]string{
		{"iam", "role", "create"},
		{"iam", "access-binding", "create"},
		{"configuration", "create"},
		{"secret", "create"},
		{"agent", "create"},
		{"credential-source", "create"},
		// Update bodies have rules the API reference owns: agent update needs
		// configurationId, and configuration update keeps omitted secretBindings
		// (finding D766).
		{"configuration", "update"},
		{"agent", "update"},
		{"credential-source", "update"},
	} {
		command, _, err := root.Find(path)
		if err != nil || command == root {
			t.Fatalf("occ %s: %v", strings.Join(path, " "), err)
		}
		invocation := "occ " + strings.Join(path, " ")
		if path[len(path)-1] == "update" {
			if path[0] == "credential-source" {
				invocation += " cs_00000000-0000-4000-8000-000000000001"
			} else {
				invocation += " <" + path[0] + "-id>"
			}
		}
		checkJSONExample(t, command, invocation+" --file")
	}
}

func checkJSONExample(t *testing.T, command *cobra.Command, invocation string) {
	t.Helper()
	if !strings.Contains(command.Example, invocation) {
		t.Fatalf("%s: example does not show %q:\n%s", command.CommandPath(), invocation, command.Example)
	}
	body := exampleBody(command.Example)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil || len(decoded) == 0 {
		t.Fatalf("%s: example body %q is not a JSON object: %v", command.CommandPath(), body, err)
	}
	if command.CommandPath() == "occ credential-source create" || command.CommandPath() == "occ credential-source update" {
		for _, safeInput := range []string{"umask 077", "$(mktemp -- ", "trap 'rm -f --", "jq -Rs ", "< /path/to/key", `--file "$source_file"`} {
			if !strings.Contains(command.Example, safeInput) {
				t.Fatalf("%s: example does not protect credential input with %q", command.CommandPath(), safeInput)
			}
		}
		if strings.Contains(command.Example, "<<") {
			t.Fatalf("%s: example must not put credentials in a shell heredoc", command.CommandPath())
		}
		secret, ok := decoded["secret"].(map[string]any)
		if !ok || len(secret) != 1 || secret["opaque"] == "" || secret["opaque"] == nil {
			t.Fatalf("%s: example must supply one write-only credential: %#v", command.CommandPath(), decoded)
		}
		if command.Name() == "create" && decoded["type"] != "static" {
			t.Fatalf("%s: example type = %#v, want static", command.CommandPath(), decoded["type"])
		}
	}
}
