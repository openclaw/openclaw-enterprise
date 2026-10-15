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
	} {
		command, _, err := root.Find(path)
		if err != nil || command == root {
			t.Fatalf("occ %s: %v", strings.Join(path, " "), err)
		}
		checkJSONExample(t, command, "occ "+strings.Join(path, " ")+" --file")
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
}
