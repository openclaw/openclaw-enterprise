package occcli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

func TestRateLimitedErrorNamesTheRetryAfterDelay(t *testing.T) {
	for _, test := range []struct {
		retryAfter, body, want string
	}{
		{"7", `{"error":{"code":"RUNTIME_LOGS_RATE_LIMITED","message":"Too many runtime log requests. Wait for Retry-After and try again."}}`,
			"OCC operation failed (HTTP 429): RUNTIME_LOGS_RATE_LIMITED: Too many runtime log requests. Wait for Retry-After and try again. Retry after 7s."},
		{"120", `not json`, "OCC operation failed (HTTP 429). Retry after 120s."},
		{"", `{"error":{"code":"RATE_LIMITED","message":"Slow down."}}`, "OCC operation failed (HTTP 429): RATE_LIMITED: Slow down."},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			if test.retryAfter != "" {
				writer.Header().Set("retry-after", test.retryAfter)
			}
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(test.body))
		}))
		keyFile := writeKeyFile(t, `{"data":{"key":"test-key"}}`)
		var out bytes.Buffer
		command := New(&out, &bytes.Buffer{})
		command.SetArgs([]string{"--url", server.URL, "--service-key-file", keyFile, "--namespace", testNamespaceID, "agent", "list"})
		err := command.Execute()
		server.Close()
		if err == nil || err.Error() != test.want {
			t.Errorf("Retry-After %q: error = %v, want %q", test.retryAfter, err, test.want)
		}
		if strings.TrimSpace(out.String()) != "" {
			t.Errorf("Retry-After %q: stdout = %q, want nothing", test.retryAfter, out.String())
		}
	}
}

func TestAgentLogFollowHonorsRetryAfterDateForms(t *testing.T) {
	for _, test := range []struct {
		name, format, fixed string
		fallback            bool
	}{
		{name: "HTTP date", format: http.TimeFormat},
		{name: "obsolete RFC850 date", format: time.RFC850},
		{name: "obsolete asctime date", format: time.ANSIC},
		{name: "seconds", fixed: "5"},
		{name: "invalid", fixed: "not a date", fallback: true},
		{name: "zero", fixed: "0", fallback: true},
		{name: "past date", format: http.TimeFormat, fallback: true},
		{name: "date beyond supported hour", format: http.TimeFormat, fallback: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			sleeps := recordSleeps(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			retry := func(w http.ResponseWriter, q url.Values) {
				value := test.fixed
				if test.format != "" {
					when := time.Now().Add(30 * time.Second).In(time.FixedZone("GMT", 0))
					if test.name == "past date" {
						when = when.Add(-time.Hour)
					}
					if test.name == "date beyond supported hour" {
						when = when.Add(2 * time.Hour)
					}
					value = when.Format(test.format)
				}
				logError(http.StatusTooManyRequests, "RUNTIME_LOGS_RATE_LIMITED", map[string]string{"retry-after": value})(w, q)
			}
			stub := &runtimeLogStub{t: t, pages: []func(http.ResponseWriter, url.Values){retry, logPage("", logLine(1, "info", "ready after retry"))}}
			var output strings.Builder
			var notices strings.Builder
			sink := logOutputFunc(func(b []byte) (int, error) {
				n, err := output.Write(b)
				if strings.Contains(output.String(), "ready after retry") {
					cancel()
				}
				return n, err
			})
			if err := runLogsCommandTo(t, ctx, stub, sink, &notices, "agent", "logs", "agt_1", "--revision", "rev_1", "--source", "gateway", "--follow"); err != nil {
				t.Fatal(err)
			}
			if len(*sleeps) != 1 {
				t.Fatalf("sleeps=%v", *sleeps)
			}
			delay := (*sleeps)[0]
			switch {
			case test.fallback:
				if delay != 2*time.Second {
					t.Fatalf("fallback wait=%v; want 2s", delay)
				}
			case test.fixed != "":
				if delay != 5*time.Second {
					t.Fatalf("seconds wait=%v; want 5s", delay)
				}
			default:
				if delay < 20*time.Second || delay > 30*time.Second {
					t.Fatalf("date wait=%v; should wait until server date", delay)
				}
				if delay%time.Second != 0 {
					t.Fatalf("date wait=%v; want whole seconds", delay)
				}
				if got := notices.String(); strings.Contains(got, ".") || !strings.Contains(got, "retrying in "+delay.String()) {
					t.Fatalf("notice=%q; want whole-second retry delay", got)
				}
			}
		})
	}
}

func TestAPIErrorRoundsRemainingRetryDelayUp(t *testing.T) {
	err := &occclient.APIError{Status: http.StatusTooManyRequests, RetryAfter: 1500 * time.Millisecond}
	if got := err.Error(); !strings.Contains(got, "Retry after 2s.") {
		t.Fatalf("message=%q", got)
	}
}
