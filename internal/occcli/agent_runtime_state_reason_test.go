package occcli

import (
	"bytes"
	"strings"
	"testing"
)

func TestAgentRuntimeTableShowsCurrentContainerReason(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		restarted    bool
		want         string // STATE, RESTARTS, LAST TERMINATION (ignoring column padding)
	}{
		{"first start", "ImagePullBackOff", false, "waiting (ImagePullBackOff) 0 -"},
		{"current and previous reasons", "BackOff\u202eretry", true, `"waiting (BackOff\u202eretry)" 1 OOMKilled exit 137`},
		{"no current reason", "", true, "waiting 1 OOMKilled exit 137"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := map[string]any{"name": "gateway", "state": "waiting", "reason": tc.reason, "restartCount": 0}
			if tc.restarted {
				gateway["restartCount"] = 1
				gateway["lastTermination"] = map[string]any{"reason": "OOMKilled", "exitCode": float64(137)}
			}
			pod := map[string]any{"name": "gw-0", "role": "gateway", "containers": []any{
				map[string]any{"name": "sidecar", "state": "running", "reason": "SidecarReason"},
				gateway,
			}}
			var out bytes.Buffer
			app := &application{out: &out}
			if err := app.printRuntime(map[string]any{"pods": []any{pod}}, "ns_00000000-0000-4000-8000-000000000001", "agt_00000000-0000-4000-8000-000000000001", "rev_00000000-0000-4000-8000-000000000001"); err != nil {
				t.Fatal(err)
			}
			_, row, _ := strings.Cut(out.String(), "\n")
			if got := strings.Join(strings.Fields(row), " "); !strings.HasSuffix(got, " "+tc.want) {
				t.Errorf("pod row = %q, want suffix %q", got, tc.want)
			}
		})
	}
}

// A Pod with one container reports it whatever its name; one container per role is read only
// when the Pod has several. A Pod entry that is not an object is refused, not skipped.
func TestAgentRuntimeTableReadsASoleContainerAndRefusesMalformedPods(t *testing.T) {
	pod := map[string]any{"name": "sbx-0", "role": "sandbox", "containers": []any{
		map[string]any{"name": "agent", "state": "running", "restartCount": float64(4)},
	}}
	var out bytes.Buffer
	app := &application{out: &out}
	if err := app.printRuntime(map[string]any{"pods": []any{pod}}, "ns_00000000-0000-4000-8000-000000000001", "agt_00000000-0000-4000-8000-000000000001", "rev_00000000-0000-4000-8000-000000000001"); err != nil {
		t.Fatal(err)
	}
	_, row, _ := strings.Cut(out.String(), "\n")
	if got := strings.Join(strings.Fields(row), " "); !strings.HasSuffix(got, " running 4 -") {
		t.Errorf("pod row = %q, want the sole container's state and restarts", got)
	}
	out.Reset()
	err := app.printRuntime(map[string]any{"pods": []any{pod, "sbx-1"}}, "ns_00000000-0000-4000-8000-000000000001", "agt_00000000-0000-4000-8000-000000000001", "rev_00000000-0000-4000-8000-000000000001")
	if err == nil || err.Error() != "OCC returned an invalid runtime description" || out.Len() != 0 {
		t.Errorf("malformed Pod: error = %v, output = %q", err, out.String())
	}
}
