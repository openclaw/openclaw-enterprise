package occcli

import (
	"net/http"
	"sync/atomic"
	"testing"
)

func TestDeployRejectsInvalidRetainedHarnessRevisionBeforeRequest(t *testing.T) {
	for _, test := range []struct {
		name string
		id   string
	}{
		{name: "malformed revision", id: "rev_bad"},
		{name: "wrong ID kind", id: testAgentID},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				http.NotFound(w, r)
			})
			want := revisionIDArg.check(test.id, testNamespaceID)
			_, _, err := runOCCAgainst(t, handler, "--namespace", testNamespaceID, "agent", "deploy", testAgentID, "--retain-harness-overrides", test.id)
			if err == nil || err.Error() != want.Error() || calls.Load() != 0 {
				t.Fatalf("error = %v, requests = %d; want error %q and zero requests", err, calls.Load(), want)
			}
		})
	}
}
