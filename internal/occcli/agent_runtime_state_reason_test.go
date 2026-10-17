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
			if err := app.printRuntime(map[string]any{"pods": []any{pod}}); err != nil {
				t.Fatal(err)
			}
			_, row, _ := strings.Cut(out.String(), "\n")
			if got := strings.Join(strings.Fields(row), " "); !strings.HasSuffix(got, " "+tc.want) {
				t.Errorf("pod row = %q, want suffix %q", got, tc.want)
			}
		})
	}
}
