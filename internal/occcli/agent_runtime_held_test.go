package occcli

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const heldGatewayLine = "\nGateway check failed: gateway-state-lock (UNAVAILABLE). Its log names the cause (occ --namespace ns_00000000-0000-4000-8000-000000000001 agent logs agt_00000000-0000-4000-8000-000000000001 --source gateway --revision rev_00000000-0000-4000-8000-000000000001); see https://docs-enterprise.openclaw.org/guides/topics/agent-troubleshoot/\n"

// A Gateway held on a startup check shows only READY false in Pod status; the table names
// the check from the revision's diagnostics, and anything else leaves the table as it was.
func TestAgentRuntimeNamesTheCheckAHeldGatewayFails(t *testing.T) {
	heldChecks := `[{"component":"agent","check":"workspace-baseline","state":"failed","checkedAt":null,"code":"UNAVAILABLE"},` +
		`{"component":"gateway","check":"gateway-state-lock","state":"failed","checkedAt":"2026-09-30T12:00:00.000Z","code":"UNAVAILABLE"},` +
		`{"component":"gateway","check":"slack-channel","state":"failed","checkedAt":null}]`
	for _, test := range []struct {
		name, state string
		ready       bool
		diagnostics string // the diagnostics response data; "forbidden" refuses the call
		output      string
		diagnoses   bool
		want        string
	}{
		{"held", "running", false, `{"checks":` + heldChecks + `}`, "table", true, heldGatewayLine},
		{"may not diagnose", "running", false, "forbidden", "table", true, ""},
		{"no failed Gateway check", "running", false, `{"checks":[{"component":"gateway","check":"slack-channel","state":"succeeded","checkedAt":null}]}`, "table", true, ""},
		{"unsafe check name", "running", false, `{"checks":[{"component":"gateway","check":"lock\u001b[2J","state":"failed","checkedAt":null}]}`, "table", true, ""},
		{"ready", "running", true, `{"checks":` + heldChecks + `}`, "table", false, ""},
		{"waiting", "waiting", false, `{"checks":` + heldChecks + `}`, "table", false, ""},
		{"JSON output", "running", false, `{"checks":` + heldChecks + `}`, "json", false, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			stub := &runtimeLogStub{t: t, activeID: "rev_00000000-0000-4000-8000-000000000001"}
			diagnosed := 0
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				switch {
				case strings.HasSuffix(request.URL.Path, "/diagnostics") && request.Method == http.MethodPost:
					diagnosed++
					if test.diagnostics == "forbidden" {
						logError(http.StatusForbidden, "FORBIDDEN", nil)(response, nil)
						return
					}
					fmt.Fprintf(response, `{"data":%s,"meta":{}}`, test.diagnostics)
				case strings.HasSuffix(request.URL.Path, "/runtime"):
					fmt.Fprintf(response, `{"data":{"revisionId":"rev_00000000-0000-4000-8000-000000000001","observedAt":"2026-09-30T12:00:00.000Z","pods":[{"role":"gateway","cluster":"control","name":"gw-0","uid":"u","phase":"Running","ready":%t,"createdAt":null,"containers":[{"name":"gateway","state":%q,"reason":null,"ready":%t,"restartCount":1,"startedAt":null,"lastTermination":null}],"events":[]}],"sources":[]},"meta":{}}`, test.ready, test.state, test.ready)
				default:
					stub.serve(response, request)
				}
			}))
			t.Cleanup(server.Close)
			var out, errOut strings.Builder
			command := New(&out, &errOut)
			command.SetArgs([]string{"agent", "runtime", "agt_00000000-0000-4000-8000-000000000001", "--revision", "rev_00000000-0000-4000-8000-000000000001", "-o", test.output,
				"--url", server.URL, "--service-key-file", writeKeyFile(t, `{"data":{"key":"test-key"}}`), "--namespace", "ns_00000000-0000-4000-8000-000000000001"})
			if err := command.ExecuteContext(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := diagnosed > 0; got != test.diagnoses {
				t.Errorf("diagnostics called = %t, want %t", got, test.diagnoses)
			}
			if test.want != "" && !strings.HasSuffix(out.String(), test.want) {
				t.Errorf("output = %q, want suffix %q", out.String(), test.want)
			}
			if test.want == "" && strings.Contains(out.String(), "Gateway check failed") {
				t.Errorf("output names a check:\n%s", out.String())
			}
			if errOut.Len() != 0 {
				t.Errorf("stderr = %q", errOut.String())
			}
		})
	}
}
