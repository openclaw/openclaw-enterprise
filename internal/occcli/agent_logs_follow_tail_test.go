package occcli

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Follow polls must repeat the tail the operator accepted. OCC binds a log
// cursor to that tail; a later poll that substitutes 1000 lines invalidates
// the checkpoint, so the next page reports a false gap and can replay or drop
// lines. The default tail is 200, and an explicit --tail is kept too.
func TestAgentLogsFollowRepeatsTheAcceptedTail(t *testing.T) {
	for _, test := range []struct {
		name, tail, pod, level string
		extra                  []string
	}{
		{name: "default tail", tail: "200", extra: []string{"--source", "gateway"}},
		{name: "explicit tail", tail: "50", pod: "gw-0", level: "warn", extra: []string{"--source", "gateway", "--tail", "50", "--pod", "gw-0", "--level", "warn"}},
		{name: "sandbox tail", tail: "20", extra: []string{"--source", "sandbox", "--tail", "20"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stub := &runtimeLogStub{t: t, activeID: "rev_00000000-0000-4000-8000-000000000001", pages: []func(http.ResponseWriter, url.Values){
				logPage("v1.first.sig", logLine(1, "info", "ready")),
				logPage("v1.second.sig", logLine(2, "info", "later")),
			}}
			original := sleepContext
			t.Cleanup(func() { sleepContext = original })
			sleepContext = func(context.Context, time.Duration) error {
				// Stop after the follow poll has been sent and its page printed.
				if len(stub.queries) >= 2 {
					cancel()
					return context.Canceled
				}
				return nil
			}
			args := append([]string{
				"agent", "logs", "agt_00000000-0000-4000-8000-000000000001",
				"--revision", "rev_00000000-0000-4000-8000-000000000001",
				"--follow",
			}, test.extra...)
			out, _, err := runLogsCommand(t, ctx, stub, args...)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out, "ready") || !strings.Contains(out, "later") {
				t.Fatalf("output = %q, want both pages", out)
			}
			if len(stub.queries) != 2 {
				t.Fatalf("log queries = %d, want the first page and one follow poll", len(stub.queries))
			}
			first, poll := stub.queries[0], stub.queries[1]
			if first.Get("tailLines") != test.tail || first.Get("cursor") != "" {
				t.Fatalf("first query = %v, want tailLines=%s and no cursor", first, test.tail)
			}
			if poll.Get("cursor") != "v1.first.sig" {
				t.Fatalf("follow cursor = %q", poll.Get("cursor"))
			}
			if got := poll.Get("tailLines"); got != test.tail {
				t.Fatalf("follow poll tailLines = %q, want the accepted tail %q", got, test.tail)
			}
			if poll.Get("pod") != test.pod || poll.Get("minLevel") != test.level || poll.Get("sinceSeconds") != "" {
				t.Fatalf("follow poll changed the view: %v", poll)
			}
		})
	}
}
