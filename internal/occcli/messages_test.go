package occcli

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Messages occ writes itself name a plain cause and a next step instead of
// transport, parser or flag-library text (findings D740, D743, D745, D746).

func TestRejectedServiceKeyNamesTheKeyFileNotHeaderAdvice(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":{"code":"UNAUTHENTICATED","message":"A valid session cookie or service API key is required: the credential sent is missing, invalid, expired, or revoked. Send service API keys in the x-api-key header; Authorization bearer tokens are not accepted."}}`))
	}))
	defer server.Close()
	keyFile := writeKeyFile(t, `{"data":{"key":"revoked-key-value"}}`)
	_, _, err := runHelp(t, "--url", server.URL, "--service-key-file", keyFile, "installation", "get")
	want := "OCC rejected the service key in " + keyFile + ": it is invalid, expired or revoked. Ask an Installation administrator for a new key."
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	if strings.Contains(err.Error(), "revoked-key-value") {
		t.Fatal("the error must never print the key")
	}
}

func TestServiceKeyFileErrorsNameTheReason(t *testing.T) {
	const advice = ` Use the complete JSON file from "occ service-key create".`
	for _, test := range []struct {
		contents string
		reason   string
	}{
		{`{"data":{}}`, "has no data.key."},
		{`{"data":{"key":""}}`, "has no data.key."},
		{`{"data":{"key":"   "}}`, "has an empty data.key."},
		{`{"data":{"key":"abc\ndef"}}`, "has a data.key split over lines."},
		{`{"data":{"key":42}}`, "has no usable data.key (it must be a JSON string)."},
		{`{"data":{"key":"abc`, "is not JSON."},
		{`not json`, "is not JSON."},
	} {
		keyFile := writeKeyFile(t, test.contents)
		_, _, err := runHelp(t, "--url", "http://127.0.0.1:9", "--service-key-file", keyFile, "installation", "get")
		if want := "service-key file " + keyFile + " " + test.reason + advice; err == nil || err.Error() != want {
			t.Errorf("%q: error = %v, want %q", test.contents, err, want)
		}
	}
	missing := filepath.Join(t.TempDir(), "missing.json")
	_, _, err := runHelp(t, "--url", "http://127.0.0.1:9", "--service-key-file", missing, "installation", "get")
	if want := "service-key file " + missing + " does not exist. Set OCC_SERVICE_KEY_FILE (or --service-key-file) to the key file you were issued."; err == nil || err.Error() != want {
		t.Errorf("missing file: error = %v, want %q", err, want)
	}
	// A directory cannot be read as a file; the cause stays, without the path twice.
	directory := t.TempDir()
	_, _, err = runHelp(t, "--url", "http://127.0.0.1:9", "--service-key-file", directory, "installation", "get")
	if want := "failed to read service-key file " + directory + ": is a directory"; err == nil || err.Error() != want {
		t.Errorf("directory: error = %v, want %q", err, want)
	}
}

func TestUntrustedEndpointCertificateNamesTheCABundleSetting(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
	_, _, err := runHelp(t, "--url", server.URL, "--service-key-file", keyFile, "--ca-bundle=", "installation", "get")
	if want := "the OCC endpoint's certificate is not trusted. Set OCC_CA_BUNDLE (or --ca-bundle) to your Installation's CA bundle."; err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	// A bundle that does not sign the endpoint names the bundle it used.
	// (httptest servers share one certificate, so the bundle holds a new one.)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "other CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	otherCA, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(bundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: otherCA}), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err = runHelp(t, "--url", server.URL, "--service-key-file", keyFile, "--ca-bundle", bundle, "installation", "get")
	if want := "the OCC endpoint's certificate is not trusted by the CA bundle " + bundle + ". Set OCC_CA_BUNDLE (or --ca-bundle) to your Installation's CA bundle."; err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	// A trusted certificate for another name says so and keeps the cause.
	trusted := filepath.Join(t.TempDir(), "server.pem")
	if err := os.WriteFile(trusted, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	localhost := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	_, _, err = runHelp(t, "--url", localhost, "--service-key-file", keyFile, "--ca-bundle", trusted, "installation", "get")
	if err == nil || !strings.HasPrefix(err.Error(), "OCC operation failed: the OCC endpoint's certificate is not valid for localhost; check OCC_URL: ") {
		t.Fatalf("hostname mismatch error = %v", err)
	}
}

func TestLogsSinceNamesTheAcceptedUnits(t *testing.T) {
	_, _, err := runHelp(t, "agent", "logs", testAgentID, "--source", "gateway", "--since", "3d")
	if want := `invalid argument "3d" for "--since" flag: use h, m or s, for example 12h or 90m; at most 24h`; err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestMissingCommandsPointAtWhatOCCOffers(t *testing.T) {
	for _, name := range []string{"OCC_URL", "OCC_SERVICE_KEY_FILE", "OCC_CA_BUNDLE", "OCC_TIMEOUT_SECONDS", "OCC_NAMESPACE"} {
		t.Setenv(name, "")
	}
	const signIn = "occ has no sign-in command: it uses a service key file. Set OCC_SERVICE_KEY_FILE to the key an Installation administrator issued you."
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"login"}, `unknown command "login" for "occ". ` + signIn},
		{[]string{"auth", "login"}, `unknown command "auth" for "occ". ` + signIn},
		{[]string{"device-login"}, `unknown command "device-login" for "occ". ` + signIn},
		{[]string{"whoami"}, `unknown command "whoami" for "occ". ` + signIn},
		{[]string{"configuration", "list"}, `unknown command "list" for "occ configuration". occ has no configuration list; the CONFIGURATION column of "occ agent list" shows each Agent's Configuration ID.`},
		// A one-letter typo of a subcommand gets a suggestion (finding D765).
		{[]string{"agent", "lst"}, `unknown command "lst" for "occ agent"; did you mean "occ agent list"?`},
		{[]string{"secrets"}, `unknown command "secrets" for "occ"; did you mean "occ secret"?`},
		{[]string{"agent", "gat"}, `unknown command "gat" for "occ agent"; did you mean "occ agent get"?`},
		// A prefix suggests only the one command it starts, and only from two characters.
		{[]string{"agent", "revi"}, `unknown command "revi" for "occ agent"; did you mean "occ agent revisions"?`},
		{[]string{"agent", "de"}, `unknown command "de" for "occ agent"`},
		{[]string{"agent", "u"}, `unknown command "u" for "occ agent"`},
		{[]string{"agent", ""}, `unknown command "" for "occ agent"`},
		// Anything else keeps cobra's text: "lst" is two edits from "get".
		{[]string{"configuration", "lst"}, `unknown command "lst" for "occ configuration"`},
	} {
		out, _, err := runHelp(t, test.args...)
		if err == nil || err.Error() != test.want {
			t.Errorf("occ %v error = %v, want %q", test.args, err, test.want)
		}
		if out != "" {
			t.Errorf("occ %v stdout = %q, want nothing", test.args, out)
		}
	}
}

func TestEmptyListsSayTheyAreFilteredByReadAccess(t *testing.T) {
	namespacePath := "GET /namespaces/" + testNamespaceID
	agentPath := namespacePath + "/agents/" + testAgentID
	for _, test := range []struct {
		args      []string
		responses map[string]string
		want      string
	}{
		{[]string{"secret", "list"}, map[string]string{namespacePath + "/secrets": `[]`}, "No Secrets you can read.\n"},
		{[]string{"agent", "list"}, map[string]string{namespacePath + "/agents": `[]`}, "No Agents you can read.\n"},
		{[]string{"service-account", "list"}, map[string]string{namespacePath + "/service-accounts": `[]`}, "No ServiceAccounts you can read.\n"},
		{
			[]string{"agent", "revisions", testAgentID},
			map[string]string{agentPath: `{"id":"` + testAgentID + `"}`, agentPath + "/revisions": `[]`},
			"No revisions you can read. Revisions need AgentRevision read; ask an Installation administrator.\n",
		},
	} {
		out, _, err := runOCC(t, test.responses, append([]string{"--namespace", testNamespaceID}, test.args...)...)
		if err != nil || out != test.want {
			t.Errorf("occ %v = %q, %v; want %q", test.args, out, err, test.want)
		}
	}
	// Structured output stays an empty array.
	out, _, err := runOCC(t, map[string]string{"GET /namespaces/" + testNamespaceID + "/secrets": `[]`}, "--namespace", testNamespaceID, "secret", "list", "-o", "json")
	if err != nil || strings.TrimSpace(out) != "[]" {
		t.Errorf("secret list -o json = %q, %v", out, err)
	}
}

func TestDeployNamesANewRevisionTheDeployerCannotRead(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	revision := `{"id":"` + testRevision1ID + `","revision":2,"agentId":"` + testAgentID + `","configurationId":"cfg_77777777-7777-4777-8777-777777777777"}`
	notice := "notice: you cannot read new revision " + testRevision1ID + ", so deployment-status and logs cannot show its outcome. Ask an Installation administrator for AgentRevision read on it.\n"
	for _, test := range []struct {
		name   string
		status string
		want   string
	}{
		{"unreadable", `raw:403 {"error":{"code":"FORBIDDEN","message":"Not authorized: this needs AgentRevision read on AgentRevision ` + testRevision1ID + `."}}`, notice},
		{"readable", `{"id":"` + testRevision1ID + `","status":"pending"}`, ""},
	} {
		out, errOut, requested, err := runOCCWithNotices(t, map[string]string{
			"POST " + agentPath + "/deploy":                        revision,
			"GET " + agentPath + "/deployments/" + testRevision1ID: test.status,
		}, "--namespace", testNamespaceID, "agent", "deploy", testAgentID)
		if err != nil || !strings.Contains(out, testRevision1ID) {
			t.Fatalf("%s: deploy = %q, %v", test.name, out, err)
		}
		if errOut != test.want {
			t.Errorf("%s: stderr = %q, want %q", test.name, errOut, test.want)
		}
		if want := []string{"POST " + agentPath + "/deploy", "GET " + agentPath + "/deployments/" + testRevision1ID}; !slices.Equal(requested, want) {
			t.Errorf("%s: requests = %v, want %v", test.name, requested, want)
		}
	}
}

func TestStopOnAnAgentThatNeverRanSaysNothingRuns(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	stopped := `{"id":"` + testAgentID + `","name":"draft","namespaceId":"` + testNamespaceID + `","desiredRuntimeState":"stopped"}`
	deploy := `"occ --namespace ` + testNamespaceID + ` agent deploy ` + testAgentID + `"`
	for _, test := range []struct {
		name   string
		before string
		want   string
	}{
		{"never ran", stopped, "notice: No version is running, so there is nothing to stop. Run " + deploy + " to start the Agent.\n"},
		// A first deployment in progress has no active revision yet, but it runs.
		{"first deploy", `{"id":"` + testAgentID + `","desiredRuntimeState":"running"}`, "notice: stop requested; run " + deploy + " to start the Agent again\n"},
		// A second stop while the first still shuts down says so (finding D765).
		// The earlier stop may still run or may have failed, so the notice claims neither.
		{"stopping", `{"id":"` + testAgentID + `","desiredRuntimeState":"stopped","activeRevisionId":"` + testRevision1ID + `"}`, "notice: a stop of Agent " + testAgentID + ` was already requested and has not finished; run "occ --namespace ` + testNamespaceID + ` agent get ` + testAgentID + `" to see its state, or ` + deploy + " to start it again\n"},
		// A caller who cannot read the Agent learns nothing from the read.
		{"unreadable", `raw:403 {"error":{"code":"FORBIDDEN","message":"Not authorized: this needs Agent read on Agent ` + testAgentID + `."}}`, "notice: stop requested; run " + deploy + " to start the Agent again\n"},
	} {
		_, errOut, _, err := runOCCWithNotices(t, map[string]string{
			"GET " + agentPath:            test.before,
			"POST " + agentPath + "/stop": stopped,
		}, "--namespace", testNamespaceID, "agent", "stop", testAgentID)
		if err != nil || errOut != test.want {
			t.Errorf("%s: stop = %q, %v; want %q", test.name, errOut, err, test.want)
		}
	}
}

func TestLogsFollowSaysAccessChangedAfterARefusalMidFollow(t *testing.T) {
	recordSleeps(t)
	stub := &runtimeLogStub{t: t, activeID: "rev_00000000-0000-4000-8000-000000000001", pages: []func(http.ResponseWriter, url.Values){
		logPage("v1.first.sig", logLine(1, "info", "ready")),
		logError(http.StatusForbidden, "FORBIDDEN", nil),
	}}
	out, _, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_00000000-0000-4000-8000-000000000001", "--source", "gateway", "--follow")
	want := "your access to Agent agt_00000000-0000-4000-8000-000000000001 changed while following its logs; log text now needs Agent read_logs (or Agent administer). Ask an Installation administrator if you still need it."
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	if !strings.Contains(out, "ready") {
		t.Fatalf("stdout = %q, want the line read before the refusal", out)
	}
}

// Finding D765: argument-count refusals name the IDs the command takes and the
// next step instead of cobra's "accepts between 1 and 1 arg(s), received 2".
func TestArgumentCountRefusalsNameTheExpectedIDs(t *testing.T) {
	inNamespace := "occ --namespace " + testNamespaceID
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"agent", "runtime", testAgentID, testRevision1ID}, "occ agent runtime takes one Agent ID but got 2 arguments; pass the revision with --revision"},
		{[]string{"agent", "logs", testAgentID, testRevision1ID, "--source", "gateway"}, "occ agent logs takes one Agent ID but got 2 arguments; pass the revision with --revision"},
		{[]string{"agent", "get", testAgentID, testAgentID}, "occ agent get takes one Agent ID but got 2 arguments"},
		{[]string{"agent", "get"}, `occ agent get takes one Agent ID but got none; run "` + inNamespace + ` agent list" to find the Agent ID`},
		{[]string{"agent", "credential-withdrawal", "request", testAgentID}, `occ agent credential-withdrawal request takes an Agent ID and a credential source ID but got 1 argument; run "` + inNamespace + ` credential-source list" to find the credential source ID`},
		{[]string{"agent", "deployment-status", testAgentID, testRevision1ID, testRevision1ID}, "occ agent deployment-status takes an Agent ID and an optional deployment ID but got 3 arguments"},
		{[]string{"iam", "role", "get"}, "occ iam role get takes one Role ID but got none"},
	} {
		_, requested, err := runOCC(t, map[string]string{}, append([]string{"--namespace", testNamespaceID}, test.args...)...)
		if err == nil || err.Error() != test.want {
			t.Errorf("occ %v error = %v, want %q", test.args, err, test.want)
		}
		if len(requested) != 0 {
			t.Errorf("occ %v requests = %v, want none", test.args, requested)
		}
	}
}

// Finding D765: an ID of the wrong kind is named as an ID, with the expected
// prefix, instead of being told that OCC does not accept names.
func TestWrongKindIDsNameTheExpectedPrefix(t *testing.T) {
	inNamespace := "occ --namespace " + testNamespaceID
	const configurationID = "cfg_77777777-7777-4777-8777-777777777777"
	const unknownKindID = "crs_77777777-7777-4777-8777-777777777777"
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"credential-source", "get", unknownKindID}, wrongKindIDRefusal(unknownKindID, "", "credential source", "cs_", inNamespace+" credential-source list")},
		{[]string{"agent", "get", configurationID}, wrongKindIDRefusal(configurationID, "a Configuration ID", "Agent", "agt_", inNamespace+" agent list")},
		{[]string{"agent", "deployment-status", testAgentID, testAgentID}, wrongKindIDRefusal(testAgentID, "an Agent ID", "deployment", "rev_", inNamespace+" agent revisions AGENT_ID")},
		// A name keeps the name refusal.
		{[]string{"agent", "get", "crs_agent"}, nameNotIDRefusal("crs_agent", "Agent", "agt_", inNamespace+" agent list")},
	} {
		_, requested, err := runOCC(t, map[string]string{}, append([]string{"--namespace", testNamespaceID}, test.args...)...)
		if err == nil || err.Error() != test.want {
			t.Errorf("occ %v error = %v, want %q", test.args, err, test.want)
		}
		if len(requested) != 0 {
			t.Errorf("occ %v requests = %v, want none", test.args, requested)
		}
	}
}

// Finding D765: a refused connection names the endpoint and the plain cause,
// not the Go request and dial text.
func TestUnreachableEndpointNamesTheURLAndTheCause(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closed := server.URL
	server.Close()
	keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
	_, _, err := runHelp(t, "--url", closed, "--service-key-file", keyFile, "installation", "get")
	if want := "cannot connect to OCC at " + closed + " (connection refused). Check OCC_URL (or --url)."; err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

// Finding D765: with no Namespace selected, a Namespace-scoped key file offers
// the Namespace it records; the offer is local and sends no request.
func TestMissingNamespaceOffersTheKeyFileNamespace(t *testing.T) {
	t.Setenv("OCC_NAMESPACE", "")
	for _, test := range []struct {
		name, key, want string
	}{
		{"namespace key", `{"data":{"key":"test-key","namespaceId":"` + testNamespaceID + `"}}`, "set OCC_NAMESPACE or pass --namespace; this service key works only in Namespace " + testNamespaceID + ", so pass --namespace " + testNamespaceID},
		{"installation key", `{"data":{"key":"test-key","namespaceId":null}}`, "set OCC_NAMESPACE or pass --namespace"},
		// A value that is not a Namespace ID is never printed.
		{"edited key", `{"data":{"key":"test-key","namespaceId":"ns_\u001b[31m"}}`, "set OCC_NAMESPACE or pass --namespace"},
	} {
		fake := &fakeOCC{responses: map[string]string{}}
		server := httptest.NewServer(fake)
		_, _, err := runHelp(t, "--url", server.URL, "--service-key-file", writeKeyFile(t, test.key), "agent", "list")
		server.Close()
		if err == nil || err.Error() != test.want {
			t.Errorf("%s: error = %v, want %q", test.name, err, test.want)
		}
		if len(fake.requested) != 0 {
			t.Errorf("%s: requests = %v, want none", test.name, fake.requested)
		}
	}
}
