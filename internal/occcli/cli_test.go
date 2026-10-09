package occcli

import (
	"cmp"
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

func TestResourceRequestStopsWhenCommandContextIsCanceled(t *testing.T) {
	for _, test := range []struct {
		name            string
		args            []string
		lookupRevisions bool
		cleanExit       bool
	}{
		{name: "installation", args: []string{"installation", "get"}},
		{name: "logs Agent lookup", args: []string{"agent", "logs", "agt_22222222-2222-4222-8222-222222222222", "--source", "gateway"}},
		{name: "follow Agent lookup", args: []string{"agent", "logs", "agt_22222222-2222-4222-8222-222222222222", "--source", "gateway", "--follow"}, cleanExit: true},
		{name: "logs revision lookup", args: []string{"agent", "logs", "agt_22222222-2222-4222-8222-222222222222", "--source", "gateway"}, lookupRevisions: true},
		{name: "follow revision lookup", args: []string{"agent", "logs", "agt_22222222-2222-4222-8222-222222222222", "--source", "gateway", "--follow"}, lookupRevisions: true, cleanExit: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			requestStarted := make(chan struct{}, 1)
			release := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if test.lookupRevisions && request.URL.Path == "/namespaces/ns_11111111-1111-4111-8111-111111111111/agents/agt_22222222-2222-4222-8222-222222222222" {
					// A draft Agent makes revision selection issue its second HTTP request.
					fmt.Fprint(writer, `{"data":{"id":"agt_22222222-2222-4222-8222-222222222222","activeRevisionId":null},"meta":{}}`)
					return
				}
				requestStarted <- struct{}{}
				select {
				case <-request.Context().Done():
				case <-release:
				}
			}))
			defer server.Close()
			defer close(release)

			keyFile := filepath.Join(t.TempDir(), "service-key.json")
			if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
				t.Fatal(err)
			}

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			command := New(io.Discard, io.Discard)
			command.SetArgs(append(test.args,
				"--namespace", "ns_11111111-1111-4111-8111-111111111111",
				"--url", server.URL,
				"--service-key-file", keyFile,
				"--timeout-seconds", "30",
			))

			result := make(chan error, 1)
			go func() { result <- command.ExecuteContext(ctx) }()

			select {
			case <-requestStarted:
			case <-time.After(5 * time.Second):
				t.Fatal("request never reached the server")
			}
			cancel()

			select {
			case err := <-result:
				if test.cleanExit {
					if err != nil {
						t.Fatalf("log follow must exit cleanly on cancellation: %v", err)
					}
				} else if !errors.Is(err, context.Canceled) {
					t.Fatalf("expected a canceled request to fail with context cancellation, got %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("command ignored context cancellation and kept waiting on the request")
			}
		})
	}
}

func TestCredentialSourceUpdateAndWithdrawalCommandsReachTheirRoutes(t *testing.T) {
	type call struct{ method, path, body string }
	var calls []call
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		calls = append(calls, call{request.Method, request.URL.Path, string(body)})
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"id":"cs_1","state":"pending","requestedBy":"admin","reason":"CREDENTIAL_WITHDRAWAL_PENDING"},"meta":{"requestId":"req_1"}}`))
	}))
	defer server.Close()

	directory := t.TempDir()
	keyFile := filepath.Join(directory, "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(directory, "replacement.json")
	secrets := `{"secrets":{"api_key":{"kind":"secret","namespaceId":"ns_1","id":"sec_2"}}}`
	if err := os.WriteFile(replacement, []byte(secrets), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		args []string
		want call
	}{
		{[]string{"credential-source", "update", "cs_1"}, call{http.MethodPatch, "/namespaces/ns_1/credential-sources/cs_1", "{}"}},
		{[]string{"credential-source", "update", "cs_1", "--file", replacement}, call{http.MethodPatch, "/namespaces/ns_1/credential-sources/cs_1", secrets}},
		{[]string{"credential-source", "rotate", "cs_1"}, call{http.MethodPost, "/namespaces/ns_1/credential-sources/cs_1/rotate", ""}},
		{[]string{"agent", "credential-withdrawal", "request", "agt_1", "cs_1"}, call{http.MethodPost, "/namespaces/ns_1/agents/agt_1/credential-sources/cs_1/withdraw", ""}},
		{[]string{"agent", "credential-withdrawal", "get", "agt_1", "cs_1"}, call{http.MethodGet, "/namespaces/ns_1/agents/agt_1/credential-sources/cs_1/withdrawal", ""}},
	} {
		calls = nil
		command := New(io.Discard, io.Discard)
		command.SetArgs(append(test.args, "--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_1"))
		if err := command.Execute(); err != nil {
			t.Fatalf("%v: %v", test.args, err)
		}
		if len(calls) != 1 || calls[0] != test.want {
			t.Fatalf("%v: got %+v, want %+v", test.args, calls, test.want)
		}
	}
}

type runtimeLogStub struct {
	beforeLogPage func(*http.Request)
	t             *testing.T
	queries       []url.Values
	pages         []func(http.ResponseWriter, url.Values)
	activeID      string
	// revisions is the JSON revision list; empty means the Agent has none.
	revisions string
	paths     []string
	// podless lists revisions whose runtime description has no Pods.
	podless []string
	// forbidden lists revisions whose runtime description is refused with 403.
	forbidden []string
}

func (stub *runtimeLogStub) serve(response http.ResponseWriter, request *http.Request) {
	stub.paths = append(stub.paths, request.URL.Path)
	switch {
	case request.URL.Path == "/namespaces/ns_1/agents/agt_1":
		fmt.Fprintf(response, `{"data":{"id":"agt_1","activeRevisionId":%q},"meta":{}}`, stub.activeID)
	case request.URL.Path == "/namespaces/ns_1/agents/agt_1/revisions":
		fmt.Fprintf(response, `{"data":%s,"meta":{}}`, cmp.Or(stub.revisions, "[]"))
	case strings.HasSuffix(request.URL.Path, "/runtime/logs"):
		if request.Header.Get("x-api-key") != "test-key" {
			stub.t.Errorf("missing service key")
		}
		query := request.URL.Query()
		stub.queries = append(stub.queries, query)
		if len(stub.pages) == 0 {
			stub.t.Errorf("unexpected log request %s", request.URL)
			response.WriteHeader(http.StatusInternalServerError)
			return
		}
		if stub.beforeLogPage != nil {
			stub.beforeLogPage(request)
		}
		next := stub.pages[0]
		stub.pages = stub.pages[1:]
		next(response, query)
	case strings.HasSuffix(request.URL.Path, "/runtime") && slices.ContainsFunc(stub.forbidden, func(id string) bool {
		return strings.HasSuffix(request.URL.Path, "/deployments/"+id+"/runtime")
	}):
		logError(http.StatusForbidden, "FORBIDDEN", nil)(response, nil)
	case strings.HasSuffix(request.URL.Path, "/runtime") && slices.ContainsFunc(stub.podless, func(id string) bool {
		return strings.HasSuffix(request.URL.Path, "/deployments/"+id+"/runtime")
	}):
		fmt.Fprint(response, `{"data":{"revisionId":"rev_x","observedAt":"2026-09-30T12:00:00.000Z","pods":[],"sources":[]},"meta":{}}`)
	case strings.HasSuffix(request.URL.Path, "/runtime"):
		fmt.Fprint(response, `{"data":{"revisionId":"rev_1","observedAt":"2026-09-30T12:00:00.000Z","pods":[{"role":"gateway","cluster":"control","name":"gw-0","uid":"u","phase":"Running","ready":true,"createdAt":null,"containers":[{"name":"gateway","state":"running","reason":null,"ready":true,"restartCount":2,"startedAt":null,"lastTermination":{"reason":"OOMKilled","exitCode":137,"finishedAt":null}}],"events":[{"type":"Warning","container":"gateway","reason":"Unhealthy","message":"Readiness probe failed","count":146,"lastObservedAt":"2026-09-30T11:59:00.000Z"},{"type":"Normal","container":"prepare-private-state","reason":"Started","message":"Container started","count":1,"lastObservedAt":"2026-09-30T11:00:00.000Z"},{"type":"Normal","container":null,"reason":"Scheduled","message":"Successfully assigned","count":1,"lastObservedAt":null}]}],"sources":[{"id":"gateway","kind":"container","pods":[],"available":true,"retention":"current and previous instance"}]},"meta":{}}`)
	default:
		stub.t.Errorf("unexpected request %s", request.URL)
		response.WriteHeader(http.StatusNotFound)
	}
}

func logPage(cursor string, records ...string) func(http.ResponseWriter, url.Values) {
	return logPageWithStream(&cursor, `{"source":"gateway","pod":"gw-0"}`, records...)
}

func logPageWithStream(cursor *string, stream string, records ...string) func(http.ResponseWriter, url.Values) {
	cursorJSON := "null"
	if cursor != nil {
		cursorJSON = fmt.Sprintf("%q", *cursor)
	}
	return func(response http.ResponseWriter, _ url.Values) {
		fmt.Fprintf(
			response,
			`{"data":{"revisionId":"rev_1","source":"gateway","stream":%s,"observedAt":"2026-09-30T12:00:00.000Z","records":[%s],"withheld":0,"truncated":false,"cursor":%s},"meta":{"requestId":"r"}}`,
			stream,
			strings.Join(records, ","),
			cursorJSON,
		)
	}
}

func logError(status int, code string, header map[string]string) func(http.ResponseWriter, url.Values) {
	return func(response http.ResponseWriter, _ url.Values) {
		for name, value := range header {
			response.Header().Set(name, value)
		}
		response.WriteHeader(status)
		fmt.Fprintf(response, `{"error":{"code":%q,"message":"fixed message"},"meta":{"requestId":"r"}}`, code)
	}
}

func logLine(second int, level, message string) string {
	return fmt.Sprintf(
		`{"type":"line","time":"2026-09-30T12:00:%02d.000000001Z","stream":{"source":"gateway"},"contentClass":"operational","kind":"openclaw","level":%q,"message":%q,"subsystem":"gateway","fields":{"status":503,"method":"GET /x"}}`,
		second, level, message,
	)
}

const gapRecord = `{"type":"gap","time":null,"stream":{"source":"gateway"},"reason":"stream_replaced","remedy":"Container restarted; showing the new instance."}`

func runLogsCommand(t *testing.T, ctx context.Context, stub *runtimeLogStub, args ...string) (string, string, error) {
	t.Helper()
	var out, errOut strings.Builder
	err := runLogsCommandTo(t, ctx, stub, &out, &errOut, args...)
	return out.String(), errOut.String(), err
}

func runLogsCommandTo(t *testing.T, ctx context.Context, stub *runtimeLogStub, out, errOut io.Writer, args ...string) error {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(stub.serve))
	t.Cleanup(server.Close)
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	command := New(out, errOut)
	command.SetArgs(append(args, "--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_1"))
	return command.ExecuteContext(ctx)
}

type logOutputFunc func([]byte) (int, error)

func (write logOutputFunc) Write(data []byte) (int, error) { return write(data) }

func recordSleeps(t *testing.T) *[]time.Duration {
	t.Helper()
	sleeps := []time.Duration{}
	original := sleepContext
	sleepContext = func(ctx context.Context, d time.Duration) error {
		sleeps = append(sleeps, d)
		return ctx.Err()
	}
	t.Cleanup(func() { sleepContext = original })
	return &sleeps
}

func TestAgentLogsBuildsTheQueryAndDefaultsToTheActiveRevision(t *testing.T) {
	stub := &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){
		logPage("v1.a.b", logLine(1, "warn", "slow start")),
	}}
	out, _, err := runLogsCommand(t, context.Background(), stub,
		"agent", "logs", "agt_1", "--source", "gateway", "--pod", "gw-0", "--previous", "--tail", "50", "--since", "10m", "--level", "warn")
	if err != nil {
		t.Fatal(err)
	}
	want := url.Values{
		"source": {"gateway"}, "pod": {"gw-0"}, "previous": {"true"},
		"tailLines": {"50"}, "sinceSeconds": {"600"}, "minLevel": {"warn"},
	}
	if !reflect.DeepEqual(stub.queries[0], want) {
		t.Fatalf("query = %v, want %v", stub.queries[0], want)
	}
	if got := strings.TrimSpace(out); got != `2026-09-30T12:00:01.000000001Z WARN openclaw [gateway] slow start method="GET /x" status=503` {
		t.Fatalf("text output = %q", got)
	}
}

func TestAgentLogsFollowKeepsTheLevelOnCursorPolls(t *testing.T) {
	recordSleeps(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stub := &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){
		logPage("v1.first.sig", logLine(1, "info", "ready")),
		logPage("v1.second.sig", logLine(2, "warn", "slow")),
	}}
	stub.beforeLogPage = func(*http.Request) {
		if len(stub.queries) == 2 {
			cancel()
		}
	}
	if _, _, err := runLogsCommand(t, ctx, stub,
		"agent", "logs", "agt_1", "--source", "agent", "--follow", "--level", "info"); err != nil {
		t.Fatal(err)
	}
	if len(stub.queries) != 2 {
		t.Fatalf("queries = %v", stub.queries)
	}
	for index, query := range stub.queries {
		if got := query.Get("minLevel"); got != "info" {
			t.Fatalf("query %d minLevel = %q, want info", index, got)
		}
	}
	if got := stub.queries[1].Get("cursor"); got != "v1.first.sig" {
		t.Fatalf("poll cursor = %q", got)
	}
}

func TestAgentLogsReadsTheSandboxSourceWithoutAPod(t *testing.T) {
	stub := &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){
		logPage("v1.a.b", logLine(1, "warn", "slow start")),
	}}
	if _, _, err := runLogsCommand(t, context.Background(), stub,
		"agent", "logs", "agt_1", "--source", "sandbox", "--tail", "20"); err != nil {
		t.Fatal(err)
	}
	want := url.Values{"source": {"sandbox"}, "tailLines": {"20"}}
	if !reflect.DeepEqual(stub.queries[0], want) {
		t.Fatalf("query = %v, want %v", stub.queries[0], want)
	}
}

func TestAgentLogsRejectsInvalidFlagsBeforeAnyRequest(t *testing.T) {
	for _, args := range [][]string{
		{"agent", "logs", "agt_1"},
		{"agent", "logs", "agt_1", "--source", "kubelet"},
		{"agent", "logs", "agt_1", "--source", "kubelet-sandbox"},
		{"agent", "logs", "agt_1", "--source", "sandbox", "--pod", "gw-0"},
		{"agent", "logs", "agt_1", "--source", "sandbox", "--previous"},
		{"agent", "logs", "my-agent", "--source", "gateway"},
		{"agent", "runtime", "my-agent"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--tail", "0"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--tail", "1001"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--since", "25h"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--follow", "--previous"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--level", "unknown"},
		{"agent", "logs", "agt_1", "--source", "gateway", "-o", "yaml"},
		{"agent", "runtime", "agt_1", "-o", "text"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--revision", "3"},
		{"agent", "runtime", "agt_1", "--revision", "my-deploy"},
	} {
		stub := &runtimeLogStub{t: t, activeID: "rev_1"}
		if _, _, err := runLogsCommand(t, context.Background(), stub, args...); err == nil {
			t.Errorf("%v: expected an error", args)
		}
		if len(stub.paths) != 0 {
			t.Errorf("%v: sent requests %v", args, stub.paths)
		}
	}
	// --follow exits cleanly only when the lookup failed because of cancellation.
	for _, follow := range []bool{false, true} {
		args := []string{"agent", "logs", "agt_1", "--source", "gateway"}
		if follow {
			args = append(args, "--follow")
		}
		stub := &runtimeLogStub{t: t}
		_, _, err := runLogsCommand(t, context.Background(), stub, args...)
		if err == nil || !strings.Contains(err.Error(), "has no readable revisions") {
			t.Fatalf("follow=%v: expected a missing revision error, got %v", follow, err)
		}
		if len(stub.queries) != 0 {
			t.Fatalf("follow=%v: sent %d log requests for an Agent without revisions", follow, len(stub.queries))
		}
	}
}

// A first deploy that fails leaves no active revision; the failed version is
// the one an operator needs to inspect, so runtime and logs default to it.
func TestAgentRuntimeAndLogsDefaultToLatestRevisionWithoutActiveRevision(t *testing.T) {
	revisions := `[{"id":"rev_1","revision":1},{"id":"rev_2","revision":2}]`
	stub := &runtimeLogStub{t: t, revisions: revisions, pages: []func(http.ResponseWriter, url.Values){
		logPage("", logLine(1, "error", "startup failed")),
	}}
	out, errOut, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway")
	if err != nil {
		t.Fatalf("logs: %v", err)
	}
	if !strings.Contains(out, "startup failed") {
		t.Fatalf("logs output = %q", out)
	}
	if !strings.Contains(errOut, "has no active revision; using latest revision rev_2") {
		t.Fatalf("logs notice = %q", errOut)
	}
	_, runtimeErr, err := runLogsCommand(t, context.Background(), stub, "agent", "runtime", "agt_1")
	if err != nil {
		t.Fatalf("runtime: %v", err)
	}
	if want := "/namespaces/ns_1/agents/agt_1/deployments/rev_2/runtime"; !slices.Contains(stub.paths, want) {
		t.Fatalf("runtime requests = %v, want %s", stub.paths, want)
	}
	if !strings.Contains(runtimeErr, "using latest revision rev_2") {
		t.Fatalf("runtime notice = %q", runtimeErr)
	}
}

// A failed or still-deploying dedicated replacement leaves the active revision
// stopped while the newer revision's Pods hold the failure: read the newer one
// while it has Pods, and always say which revision was read.
func TestAgentLogsDefaultToANewerRevisionWithPodsAndNameTheRevision(t *testing.T) {
	revisions := `[{"id":"rev_1","revision":1},{"id":"rev_2","revision":2}]`
	for _, test := range []struct {
		name      string
		podless   []string
		forbidden []string
		revision  string
		notice    string
	}{
		{"newer revision has Pods", nil, nil, "rev_2", "notice: reading revision rev_2, newer than the active revision rev_1 and not yet active; pass --revision rev_1 for the active revision"},
		{"newer revision has no Pods", []string{"rev_2"}, nil, "rev_1", "notice: reading the active revision rev_1\n"},
		// A log reader without Agent operate cannot read the runtime description;
		// the notice still names the newer revision it may read with --revision.
		{"newer revision runtime is refused", nil, []string{"rev_2"}, "rev_1", "notice: reading the active revision rev_1; a newer revision rev_2 exists but its runtime could not be read (OCC operation failed (HTTP 403): FORBIDDEN: fixed message); pass --revision rev_2 to read it"},
	} {
		t.Run(test.name, func(t *testing.T) {
			stub := &runtimeLogStub{t: t, activeID: "rev_1", revisions: revisions, podless: test.podless, forbidden: test.forbidden, pages: []func(http.ResponseWriter, url.Values){
				logPage("", logLine(1, "error", "plugin install failed")),
			}}
			out, errOut, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "agent")
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out, "plugin install failed") {
				t.Fatalf("logs output = %q", out)
			}
			if want := "/namespaces/ns_1/agents/agt_1/deployments/" + test.revision + "/runtime/logs"; !slices.Contains(stub.paths, want) {
				t.Fatalf("requests = %v, want %s", stub.paths, want)
			}
			if !strings.Contains(errOut, test.notice) {
				t.Fatalf("notice = %q, want %q", errOut, test.notice)
			}
		})
	}
	// `occ agent runtime` reuses the probed description of the newer revision.
	runtimeStub := &runtimeLogStub{t: t, activeID: "rev_1", revisions: revisions}
	if _, _, err := runLogsCommand(t, context.Background(), runtimeStub, "agent", "runtime", "agt_1"); err != nil {
		t.Fatal(err)
	}
	runtimePath := "/namespaces/ns_1/agents/agt_1/deployments/rev_2/runtime"
	if got := slices.Index(runtimeStub.paths, runtimePath); got < 0 || slices.Contains(runtimeStub.paths[got+1:], runtimePath) {
		t.Fatalf("runtime requests = %v, want %s exactly once", runtimeStub.paths, runtimePath)
	}
	// The active revision is the latest: no runtime probe, and the notice names it.
	stub := &runtimeLogStub{t: t, activeID: "rev_2", revisions: revisions, pages: []func(http.ResponseWriter, url.Values){
		logPage("", logLine(1, "info", "ready")),
	}}
	_, errOut, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut, "notice: reading the active revision rev_2") {
		t.Fatalf("notice = %q", errOut)
	}
	for _, path := range stub.paths {
		if strings.HasSuffix(path, "/runtime") {
			t.Fatalf("probed runtime %s although the active revision is the latest", path)
		}
	}
	// An explicit --revision skips every lookup.
	stub = &runtimeLogStub{t: t, activeID: "rev_1", revisions: revisions, pages: []func(http.ResponseWriter, url.Values){
		logPage("", logLine(1, "info", "ready")),
	}}
	if _, _, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway", "--revision", "rev_1"); err != nil {
		t.Fatal(err)
	}
	if want := []string{"/namespaces/ns_1/agents/agt_1/deployments/rev_1/runtime/logs"}; !slices.Equal(stub.paths, want) {
		t.Fatalf("requests = %v, want %v", stub.paths, want)
	}
}

func TestAgentLogsFollowPollsTheCursorHonoursRetryAfterAndPrintsGapNotices(t *testing.T) {
	for _, responseWins := range []bool{false, true} {
		name := "cancellation wins before response"
		if responseWins {
			name = "response wins before cancellation"
		}
		t.Run(name, func(t *testing.T) {
			sleeps := recordSleeps(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stub := &runtimeLogStub{t: t, activeID: "rev_1"}
			requestCanceled := make(chan struct{})
			if !responseWins {
				stub.beforeLogPage = func(request *http.Request) {
					if len(stub.queries) != 5 {
						return
					}
					// Keep the response unwritten until the real HTTP request observes Ctrl-C.
					cancel()
					select {
					case <-request.Context().Done():
					case <-time.After(5 * time.Second):
						t.Error("the in-flight log request did not observe cancellation")
					}
					close(requestCanceled)
				}
			}
			stub.pages = []func(http.ResponseWriter, url.Values){
				logPage("v1.first.sig", logLine(1, "info", "ready")),
				logError(http.StatusTooManyRequests, "RUNTIME_LOGS_RATE_LIMITED", map[string]string{"retry-after": "5"}),
				logPage("v1.second.sig", gapRecord, logLine(2, "error", "after restart")),
				logError(http.StatusBadRequest, "RUNTIME_LOGS_CURSOR_INVALID", nil),
				logPageWithStream(nil, "null"),
			}
			var stdout, stderr strings.Builder
			finalPagePrinted := false
			const noPodNotice = "notice: revision rev_1 has no running Pod for source gateway"
			notices := logOutputFunc(func(data []byte) (int, error) {
				n, err := stderr.Write(data)
				if strings.Contains(stderr.String(), noPodNotice) {
					// This real CLI notice is emitted only after decoding the final HTTP page.
					finalPagePrinted = true
					cancel()
				}
				return n, err
			})
			err := runLogsCommandTo(t, ctx, stub, &stdout, notices,
				"agent", "logs", "agt_1", "--source", "gateway", "--since", "90s", "--follow", "-o", "json")
			if err != nil {
				t.Fatalf("an interrupted follow exits cleanly: %v", err)
			}
			if !responseWins {
				select {
				case <-requestCanceled:
				case <-time.After(5 * time.Second):
					t.Fatal("the canceled request handler did not settle")
				}
			}
			if finalPagePrinted != responseWins {
				t.Fatalf("final page printed = %v, want %v", finalPagePrinted, responseWins)
			}
			if !errors.Is(ctx.Err(), context.Canceled) {
				t.Fatalf("follow context = %v, want cancellation", ctx.Err())
			}
			out, errOut := stdout.String(), stderr.String()
			cursors := []string{}
			for _, query := range stub.queries {
				cursors = append(cursors, query.Get("cursor"))
			}
			if want := []string{"", "v1.first.sig", "v1.first.sig", "v1.second.sig", ""}; !reflect.DeepEqual(cursors, want) {
				t.Fatalf("cursors = %v, want %v", cursors, want)
			}
			if stub.queries[1].Get("sinceSeconds") != "" || stub.queries[0].Get("sinceSeconds") != "90" {
				t.Fatalf("only the first request carries --since: %v", stub.queries)
			}
			// Resetting a rejected cursor restarts the original --since window.
			if got := stub.queries[4].Get("sinceSeconds"); got != "90" {
				t.Fatalf("reset window sinceSeconds = %q, want 90", got)
			}
			// Cancellation ends either ordering without scheduling another poll.
			if want := []time.Duration{2 * time.Second, 5 * time.Second, 2 * time.Second}; !reflect.DeepEqual(*sleeps, want) {
				t.Fatalf("sleeps = %v, want %v", *sleeps, want)
			}
			lines := strings.Split(strings.TrimSpace(out), "\n")
			if len(lines) != 3 {
				t.Fatalf("NDJSON lines = %d: %q", len(lines), out)
			}
			for _, line := range lines {
				var record map[string]any
				if err := json.Unmarshal([]byte(line), &record); err != nil {
					t.Fatalf("not NDJSON: %q", line)
				}
			}
			if !strings.Contains(lines[1], `"reason":"stream_replaced"`) {
				t.Fatalf("gap record missing from NDJSON: %q", lines[1])
			}
			for _, notice := range []string{
				"notice: rate limited; retrying in 5s",
				"notice: - gap stream_replaced: Container restarted; showing the new instance.",
				"notice: the cursor was rejected; starting a new view",
			} {
				if !strings.Contains(errOut, notice) {
					t.Errorf("stderr lacks %q:\n%s", notice, errOut)
				}
			}
		})
	}
}

func TestAgentLogsExitsNonZeroWhenLogsAreUnsupportedOrUnavailable(t *testing.T) {
	recordSleeps(t)
	for _, test := range []struct {
		status int
		code   string
		follow bool
	}{
		{http.StatusNotImplemented, "NOT_IMPLEMENTED", false},
		{http.StatusNotImplemented, "NOT_IMPLEMENTED", true},
		{http.StatusServiceUnavailable, "RUNTIME_LOGS_CLUSTER_RBAC", true},
		{http.StatusServiceUnavailable, "RUNTIME_LOGS_UNAVAILABLE", false},
		{http.StatusForbidden, "FORBIDDEN", true},
	} {
		stub := &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){
			logPage("v1.first.sig", logLine(1, "info", "ready")),
			logError(test.status, test.code, nil),
		}}
		args := []string{"agent", "logs", "agt_1", "--source", "gateway"}
		if test.follow {
			args = append(args, "--follow")
		} else {
			stub.pages = stub.pages[1:]
		}
		_, _, err := runLogsCommand(t, context.Background(), stub, args...)
		var apiErr *occclient.APIError
		if !errors.As(err, &apiErr) || apiErr.Status != test.status || apiErr.Code != test.code {
			t.Errorf("%d %s follow=%v: err = %v", test.status, test.code, test.follow, err)
		}
	}
}

func TestAgentRuntimePrintsPodsAndSources(t *testing.T) {
	stub := &runtimeLogStub{t: t, activeID: "rev_1"}
	out, _, err := runLogsCommand(t, context.Background(), stub, "agent", "runtime", "agt_1", "--revision", "rev_1")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"gw-0", "Running", "OOMKilled exit 137", "current and previous instance"} {
		if !strings.Contains(out, want) {
			t.Errorf("runtime table lacks %q:\n%s", want, out)
		}
	}
	// Table output names each Event's container, as JSON output does.
	eventRows := [][]string{
		{"POD", "CONTAINER", "TYPE", "REASON", "COUNT", "LAST SEEN", "MESSAGE"},
		{"gw-0", "gateway", "Warning", "Unhealthy", "146", "2026-09-30T11:59:00.000Z", "Readiness", "probe", "failed"},
		{"gw-0", "prepare-private-state", "Normal", "Started", "1", "2026-09-30T11:00:00.000Z", "Container", "started"},
		{"gw-0", "-", "Normal", "Scheduled", "1", "-", "Successfully", "assigned"},
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < len(eventRows) {
		t.Fatalf("runtime table has no Events:\n%s", out)
	}
	for index, want := range eventRows {
		got := strings.Fields(lines[len(lines)-len(eventRows)+index])
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Errorf("Event row %d = %q, want %q:\n%s", index, got, want, out)
		}
	}
}

func TestAgentStopNamesTheDeployCommandThatStartsTheAgentAgain(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":{"id":"agt_1","name":"stopped-agent","namespaceId":"ns_1","desiredRuntimeState":"stopped"},"meta":{"requestId":"req_1"}}`)
	}))
	t.Cleanup(server.Close)
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut strings.Builder
	command := New(&out, &errOut)
	command.SetArgs([]string{"agent", "stop", "agt_1", "--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_1"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"POST /namespaces/ns_1/agents/agt_1/stop"}; !slices.Equal(requests, want) {
		t.Fatalf("requests = %v, want %v", requests, want)
	}
	if !strings.Contains(out.String(), "stopped-agent") {
		t.Fatalf("stdout = %q", out.String())
	}
	if want := "notice: stop requested; run \"occ agent deploy agt_1\" to start the Agent again\n"; errOut.String() != want {
		t.Fatalf("stderr = %q, want %q", errOut.String(), want)
	}
	// Structured output stays machine-readable: the notice goes to stderr only.
	out.Reset()
	errOut.Reset()
	command = New(&out, &errOut)
	command.SetArgs([]string{"agent", "stop", "agt_1", "-o", "json", "--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_1"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out.String()), &decoded); err != nil || decoded["id"] != "agt_1" {
		t.Fatalf("json stdout = %q, %v", out.String(), err)
	}
	if want := "notice: stop requested; run \"occ agent deploy agt_1\" to start the Agent again\n"; errOut.String() != want {
		t.Fatalf("json stderr = %q, want %q", errOut.String(), want)
	}
	stop, _, err := New(io.Discard, io.Discard).Find([]string{"agent", "stop"})
	if err != nil || !strings.Contains(stop.Long, `run "occ agent deploy ID" to start the Agent again`) {
		t.Fatalf("occ agent stop help = %q, %v", stop.Long, err)
	}
}

func TestCredentialSourceListTableOmitsTheLiveGatewayStatusOnlyGetCarries(t *testing.T) {
	source := `{"id":"cs_1","name":"openai","type":"openai","state":"ready"`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/namespaces/ns_1/credential-sources":
			// The list API returns metadata only, never a live status.
			_, _ = io.WriteString(w, `{"data":[`+source+`}],"meta":{"requestId":"req_1"}}`)
		case "/namespaces/ns_1/credential-sources/cs_1":
			_, _ = io.WriteString(w, `{"data":`+source+`,"status":{"state":"ready"}},"meta":{"requestId":"req_2"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		args []string
		rows [][]string
	}{
		{[]string{"list"}, [][]string{{"ID", "NAME", "TYPE", "STATE"}, {"cs_1", "openai", "openai", "ready"}}},
		{[]string{"get", "cs_1"}, [][]string{{"ID", "NAME", "TYPE", "STATE", "GATEWAY", "STATUS"}, {"cs_1", "openai", "openai", "ready", "ready"}}},
	} {
		var out strings.Builder
		command := New(&out, io.Discard)
		command.SetArgs(append(append([]string{"credential-source"}, test.args...), "--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_1"))
		if err := command.Execute(); err != nil {
			t.Fatalf("%v: %v", test.args, err)
		}
		var got [][]string
		for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
			got = append(got, strings.Fields(line))
		}
		if !reflect.DeepEqual(got, test.rows) {
			t.Errorf("%v table = %q, want %q", test.args, got, test.rows)
		}
	}
}

func TestRedirectIsReportedWithItsTargetAndNotFollowed(t *testing.T) {
	var followed bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		followed = true
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	for _, testCase := range []struct {
		name     string
		location string
		want     string
	}{
		{
			name:     "other origin",
			location: "https://user:pass@" + strings.TrimPrefix(target.URL, "http://") + "/installation?code=secret#frag",
			want:     "redirected to https://" + strings.TrimPrefix(target.URL, "http://") + "/installation; occ does not follow redirects, so set OCC_URL (or --url) to https://" + strings.TrimPrefix(target.URL, "http://") + " ",
		},
		{name: "same origin", location: "/elsewhere/installation", want: "/elsewhere/installation; occ does not follow redirects, and OCC_URL must be the origin that serves the OCC API directly"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var sawKey string
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sawKey = r.Header.Get("x-api-key")
				w.Header().Set("location", testCase.location)
				w.WriteHeader(http.StatusPermanentRedirect)
			}))
			defer origin.Close()
			keyFile := filepath.Join(t.TempDir(), "service-key.json")
			if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			command := New(io.Discard, io.Discard)
			command.SetArgs([]string{"installation", "get", "--url", origin.URL, "--service-key-file", keyFile})
			err := command.Execute()
			if err == nil {
				t.Fatal("expected the redirect to fail the command")
			}
			if !strings.Contains(err.Error(), "HTTP 308") || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error = %q, want it to contain HTTP 308 and %q", err, testCase.want)
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "pass") {
				t.Fatalf("error echoed redirect credentials: %q", err)
			}
			if testCase.name == "same origin" && !strings.Contains(err.Error(), origin.URL+"/elsewhere/installation") {
				t.Fatalf("relative Location was not resolved against the request: %q", err)
			}
			if sawKey != "test-key" || followed {
				t.Fatalf("origin key = %q, redirect followed = %v", sawKey, followed)
			}
		})
	}
}

func TestUnknownTopLevelCommandFailsInsteadOfPrintingHelp(t *testing.T) {
	// Bare occ validates the global options, so keep the caller's OCC_* values out.
	for _, name := range []string{"OCC_URL", "OCC_SERVICE_KEY_FILE", "OCC_CA_BUNDLE", "OCC_TIMEOUT_SECONDS", "OCC_NAMESPACE"} {
		t.Setenv(name, "")
	}
	for _, args := range [][]string{{"presets", "list"}, {"agnet", "list"}} {
		var out, errOut strings.Builder
		command := New(&out, &errOut)
		command.SetArgs(args)
		err := command.Execute()
		if want := fmt.Sprintf("unknown command %q for \"occ\"", args[0]); err == nil || err.Error() != want {
			t.Fatalf("occ %v error = %v, want %q", args, err, want)
		}
		if out.Len() != 0 {
			t.Fatalf("occ %v stdout = %q, want nothing", args, out.String())
		}
	}
	var out strings.Builder
	command := New(&out, io.Discard)
	command.SetArgs(nil)
	if err := command.Execute(); err != nil {
		t.Fatalf("bare occ error = %v", err)
	}
	if !strings.Contains(out.String(), "Available Commands:") {
		t.Fatalf("bare occ stdout = %q, want help", out.String())
	}
}
