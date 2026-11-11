package occcli

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestAgentLogsOnePageReportsNoPodNoticeWriteFailure(t *testing.T) {
	const notice = "notice: revision rev_00000000-0000-4000-8000-000000000001 has no running Pod for source gateway\n"
	writeErr := errors.New("stderr unavailable")
	for _, test := range []struct {
		name    string
		format  []string
		fail    bool
		wantErr error
	}{
		{name: "writable stderr"},
		{name: "failed stderr", fail: true, wantErr: writeErr},
		{name: "NDJSON with failed stderr", format: []string{"-o", "json"}, fail: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			stub := &runtimeLogStub{t: t, pages: []func(http.ResponseWriter, url.Values){
				logPageWithStream(nil, "null"),
			}}
			var stdout, attemptedNotice strings.Builder
			stderr := logOutputFunc(func(data []byte) (int, error) {
				attemptedNotice.Write(data)
				if test.fail {
					return 0, writeErr
				}
				return len(data), nil
			})

			args := []string{
				"agent", "logs", "agt_00000000-0000-4000-8000-000000000001",
				"--revision", "rev_00000000-0000-4000-8000-000000000001", "--source", "gateway",
			}
			err := runLogsCommandTo(t, context.Background(), stub, &stdout, stderr, append(args, test.format...)...)
			if got := attemptedNotice.String(); got != notice {
				t.Errorf("stderr write = %q, want %q", got, notice)
			}
			if !errors.Is(err, test.wantErr) {
				t.Errorf("logs returned %v, want %v", err, test.wantErr)
			}
			if got := len(stub.queries); got != 1 {
				t.Errorf("log page requests = %d, want 1", got)
			}
			if stdout.Len() != 0 {
				t.Errorf("no log records, but stdout = %q", stdout.String())
			}
		})
	}
}

func TestAgentLogsFollowReportsEachNoPodPeriodOnce(t *testing.T) {
	absent := logPageWithStream(nil, "null")
	quiet := logPage("v1.quiet.sig")
	stub := &runtimeLogStub{t: t, pages: []func(http.ResponseWriter, url.Values){
		absent, absent, quiet, absent, absent,
	}}

	// Count notices before the next poll: each absence is reported immediately,
	// and a present stream with no records separates the two periods of absence.
	const notice = "notice: revision rev_00000000-0000-4000-8000-000000000001 has no running Pod for source gateway\n"
	want := []int{1, 1, 1, 2, 2}
	var notices []int
	var stdout, stderr strings.Builder
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sleep := sleepContext
	t.Cleanup(func() { sleepContext = sleep })
	sleepContext = func(context.Context, time.Duration) error {
		notices = append(notices, strings.Count(stderr.String(), notice))
		if len(notices) == len(want) {
			cancel()
		}
		return ctx.Err()
	}

	err := runLogsCommandTo(t, ctx, stub, &stdout, &stderr, "agent", "logs", "agt_00000000-0000-4000-8000-000000000001", "--revision", "rev_00000000-0000-4000-8000-000000000001", "--source", "gateway", "--follow")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(notices, want) {
		t.Errorf("cumulative no-Pod notices after each page = %v, want %v", notices, want)
	}
	if stdout.Len() != 0 {
		t.Errorf("no log records, but stdout = %q", stdout.String())
	}
}
