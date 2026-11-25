package occcli

import (
	"bytes"
	"encoding/json/v2"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGitHubSourceShortcut(t *testing.T) {
	const token = "github_pat_fixture"
	t.Setenv("GH_TOKEN", "github_pat_other")
	t.Setenv("OCC_NAMESPACE", testNamespaceID)
	t.Setenv("OCC_SERVICE_KEY_FILE", writeKeyFile(t, `{"data":{"key":"test-key"}}`))
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		if r.Method != "POST" || r.RequestURI != "/namespaces/"+testNamespaceID+"/credential-sources" || r.Header.Get("x-api-key") != "test-key" {
			t.Error("unexpected registration request")
		}
		want := map[string]any{
			"name": "GitHub acme/docs", "type": "static",
			"config": map[string]any{"provider_preset": "github", "repositories": "acme/docs:read"},
			"secret": map[string]any{"token": token},
		}
		var body map[string]any
		if err := json.UnmarshalRead(r.Body, &body); err != nil || !reflect.DeepEqual(body, want) {
			t.Error("unexpected Source body")
		}
		w.Header().Set("Content-Type", "application/json")
		switch call {
		case 1:
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, `{"data":{"id":"cs_fixture","secrets":{}},"meta":{}}`)
		case 2:
			io.WriteString(w, `{"data":{"name":"`+token+`"},"meta":{}}`)
		case 3:
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"code":"INVALID","message":"`+token+`"}}`)
		default:
			t.Error("unexpected additional request")
		}
	}))
	defer server.Close()
	t.Setenv("OCC_URL", server.URL)

	run := func(input io.Reader, args ...string) (string, error) {
		t.Helper()
		var out bytes.Buffer
		cmd := New(&out, &out)
		cmd.SetIn(input)
		cmd.SetArgs(append([]string{"credential-source", "create", "-o", "json"}, args...))
		err := cmd.Execute()
		if strings.Contains(out.String(), token) || (err != nil && strings.Contains(err.Error(), token)) {
			t.Fatal("credential exposed")
		}
		return out.String(), err
	}
	flags := []string{"--github-repo", "acme/docs"}
	out, err := run(strings.NewReader(token+"\r\n"), flags...)
	if err != nil || !strings.Contains(out, "cs_fixture") || calls.Load() != 1 {
		t.Fatalf("registration: %v", err)
	}
	for range 2 {
		if _, err := run(strings.NewReader(token), flags...); err == nil {
			t.Fatal("accepted unsafe server response")
		}
	}
	for _, input := range []string{"", "gho_fixture", "ghp_fixture", "github_pat_", token + "\n\n", token + "\r", token + " ", token + "\x00", token + strings.Repeat("x", 16384)} {
		if _, err := run(strings.NewReader(input), flags...); err == nil {
			t.Fatal("accepted invalid stdin")
		}
	}
	device, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer device.Close()
	if _, err := run(device, flags...); err == nil || !strings.Contains(err.Error(), "pipe") {
		t.Fatal("expected device refusal before reading")
	}
	for _, args := range [][]string{
		nil, {"--github-repo="}, {"--github-repo", "--file"}, {"--github-repo", "Acme/docs"},
		{"--github-repo", "acme/do..cs"}, {"--github-repo", "acme/docs.git"}, {"--github-repo", "acme/docs:write,acme/other"},
		{"--github-repo", "acme/" + token}, {"--github-repo", "acme/docs", "--github-repo", "acme/other"},
		{"--github-repo", "acme/docs", "--file", "source.json"},
		{"--github-repo", "acme/docs", "--url", "http://occ.invalid"},
		{"--github-repo", "acme/docs", "--url", server.URL + "?key=" + token},
	} {
		input := strings.NewReader(token)
		if _, err := run(input, args...); err == nil || input.Len() != len(token) {
			t.Fatal("expected invalid options to fail before reading stdin")
		}
	}
	if calls.Load() != 3 {
		t.Fatal("expected one request per valid invocation")
	}
}
