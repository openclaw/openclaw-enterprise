package occcli

import (
	"strings"
	"testing"
)

func runHelp(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	var out, errOut strings.Builder
	command := New(&out, &errOut)
	command.SetArgs(args)
	err := command.Execute()
	return out.String(), errOut.String(), err
}

func TestHelpForAnUnknownTopicFails(t *testing.T) {
	for _, args := range [][]string{{"help", "agnet"}, {"help", "agent", "lst"}} {
		out, _, err := runHelp(t, args...)
		if err == nil || !strings.HasPrefix(err.Error(), "unknown help topic") {
			t.Fatalf("occ %v error = %v, want an unknown help topic error", args, err)
		}
		if out != "" {
			t.Fatalf("occ %v stdout = %q, want nothing", args, out)
		}
	}
	if _, _, err := runHelp(t, "help", "agent", "lgos"); err == nil || !strings.Contains(err.Error(), `did you mean "agent logs"?`) {
		t.Fatalf("occ help agent lgos error = %v, want a suggestion", err)
	}
	out, _, err := runHelp(t, "help", "agent", "logs")
	if err != nil || !strings.Contains(out, "occ agent logs AGENT_ID") {
		t.Fatalf("occ help agent logs = %q, %v", out, err)
	}
}

func TestHelpAndCompletionIgnoreInvalidConnectionOptions(t *testing.T) {
	t.Setenv("OCC_TIMEOUT_SECONDS", "soon")
	for _, args := range [][]string{
		{"help"},
		{"help", "agent"},
		{"agent"},
		{"iam", "role"},
		{"completion", "bash"},
		{"__complete", "agent", ""},
		{"-o", "xml", "help", "agent"},
	} {
		out, _, err := runHelp(t, args...)
		if err != nil || out == "" {
			t.Fatalf("occ %v = %q, %v; want output and no error", args, out, err)
		}
	}
	// Commands that call OCC still reject the invalid value before any request.
	_, _, err := runHelp(t, "installation", "get", "--url", "http://127.0.0.1:9", "--service-key-file", "unused")
	if err == nil || !strings.Contains(err.Error(), "OCC timeout must be a positive integer") {
		t.Fatalf("installation get error = %v, want the timeout error", err)
	}
	// Zero would disable the request deadline, so it is refused too.
	t.Setenv("OCC_TIMEOUT_SECONDS", "0")
	_, _, err = runHelp(t, "installation", "get", "--url", "http://127.0.0.1:9", "--service-key-file", "unused")
	if err == nil || !strings.Contains(err.Error(), "OCC timeout must be a positive integer") {
		t.Fatalf("installation get with OCC_TIMEOUT_SECONDS=0 error = %v, want the timeout error", err)
	}
}

// A missing endpoint or service key names the setting to fix instead of a
// file or connection error.
func TestMissingConnectionSettingsNameTheSetting(t *testing.T) {
	t.Setenv("OCC_URL", "")
	t.Setenv("OCC_SERVICE_KEY_FILE", "")
	t.Setenv("OCC_TIMEOUT_SECONDS", "")
	for _, testCase := range []struct {
		args []string
		want string
	}{
		{[]string{"installation", "get", "--service-key-file", "unused"}, "set OCC_URL or pass --url"},
		{[]string{"installation", "get", "--url", "http://127.0.0.1:9"}, "set OCC_SERVICE_KEY_FILE or pass --service-key-file"},
	} {
		if _, _, err := runHelp(t, testCase.args...); err == nil || err.Error() != testCase.want {
			t.Fatalf("occ %v error = %v, want %q", testCase.args, err, testCase.want)
		}
	}
}

func TestAgentLogsHelpNamesTheOutputFormatsItAccepts(t *testing.T) {
	out, _, err := runHelp(t, "agent", "logs", "--help")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `Output format: text, json (default "text")`) || strings.Contains(out, "yaml") {
		t.Fatalf("agent logs help does not name text and json only:\n%s", out)
	}
	// Other commands keep the global formats, also after logs help ran in this process.
	out, _, err = runHelp(t, "agent", "list", "--help")
	if err != nil || !strings.Contains(out, `Output format: table, json, or yaml (default "table")`) {
		t.Fatalf("agent list help = %q, %v", out, err)
	}
}
