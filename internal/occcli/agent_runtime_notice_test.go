package occcli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

type runtimeNoticeWriter struct {
	attempt bytes.Buffer
	err     error
}

func (w *runtimeNoticeWriter) Write(p []byte) (int, error) {
	_, _ = w.attempt.Write(p)
	if w.err != nil {
		return 0, w.err
	}
	return len(p), nil
}

func TestAgentRuntimeReportsRevisionFallbackNoticeWriteFailure(t *testing.T) {
	const (
		namespace = "ns_00000000-0000-4000-8000-000000000001"
		agent     = "agt_00000000-0000-4000-8000-000000000001"
		revision  = "rev_00000000-0000-4000-8000-000000000001"
		config    = "cfg_00000000-0000-4000-8000-000000000001"
		requestID = "req_00000000-0000-4000-8000-000000000001"
		createdAt = "2026-09-30T12:00:00.000Z"
	)
	agentPath := "/namespaces/" + namespace + "/agents/" + agent
	revisionsPath := agentPath + "/revisions"
	runtimePath := agentPath + "/deployments/" + revision + "/runtime"
	logsPath := runtimePath + "/logs"
	notice := fmt.Sprintf("notice: agent %s has no active revision; using %s, the latest revision you can read\n", agent, revision)
	writeFailure := errors.New("synthetic stderr write failure")
	for _, tc := range []struct {
		name         string
		writerErr    error
		explicit     bool
		logs         bool
		wantRequests []string
	}{
		{name: "writable_stderr", wantRequests: []string{agentPath, revisionsPath, runtimePath}},
		{name: "failed_stderr", writerErr: writeFailure, wantRequests: []string{agentPath, revisionsPath}},
		{name: "explicit_revision_without_notice", writerErr: writeFailure, explicit: true, wantRequests: []string{runtimePath}},
		{name: "logs_writable_stderr", logs: true, wantRequests: []string{agentPath, revisionsPath, logsPath}},
		{name: "logs_failed_stderr", logs: true, writerErr: writeFailure, wantRequests: []string{agentPath, revisionsPath}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var requests []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				base := strings.Index(r.URL.Path, "/namespaces/")
				if r.Method != http.MethodGet || base < 0 || r.Header.Get("x-api-key") != "loopback-only-probe" {
					t.Errorf("unexpected loopback request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				path := r.URL.Path[base:]
				mu.Lock()
				requests = append(requests, path)
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				switch path {
				case agentPath:
					fmt.Fprintf(w, `{
						"data": {
							"id": %q, "namespaceId": %q, "name": "Loopback Agent",
							"servicePrincipalId": "principal-loopback-agent", "configurationId": %q,
							"backendId": null, "harnessAuth": {"method": "runtime"},
							"executionMode": "dedicated", "gatewayManagedMode": true,
							"desiredRuntimeState": "stopped", "status": "active", "createdAt": %q
						},
						"meta": {"requestId": %q}
					}`, agent, namespace, config, createdAt, requestID)
				case revisionsPath:
					if got := r.URL.RawQuery; got != "limit=100" {
						t.Errorf("revision query = %q, want limit=100", got)
					}
					fmt.Fprintf(w, `{
						"data": [{
							"id": %q, "namespaceId": %q, "agentId": %q, "revision": 1,
							"backendId": null, "configurationId": %q, "configurationGeneration": 1,
							"harness": {
								"id": "codex", "version": "1", "mode": "dedicated", "overrides": {},
								"configuration": {"modelProvider": {
									"baseUrl": "https://api.openai.com/v1", "protocol": "openai-responses",
									"supportsStandaloneWebSearch": false
								}}
							},
							"createdAt": %q, "deploymentStatus": "succeeded", "deploymentErrorCode": null
						}],
						"meta": {"nextCursor": null, "requestId": %q}
					}`, revision, namespace, agent, config, createdAt, requestID)
				case logsPath:
					if want := (url.Values{"source": {"gateway"}, "tailLines": {"200"}}).Encode(); r.URL.RawQuery != want {
						t.Errorf("logs query = %q, want %q", r.URL.RawQuery, want)
					}
					fmt.Fprintf(w, `{
						"data": {
							"revisionId": %q, "source": "gateway", "stream": {"source": "gateway"},
							"observedAt": "2026-09-30T12:00:02.000Z",
							"records": [{
								"type": "line", "time": "2026-09-30T12:00:01.000Z",
								"stream": {"source": "gateway"}, "contentClass": "operational",
								"kind": "openclaw", "level": "error", "message": "startup failed"
							}],
							"withheld": 0, "truncated": false, "cursor": null
						},
						"meta": {"requestId": %q}
					}`, revision, requestID)
				case runtimePath:
					fmt.Fprintf(w, `{
						"data": {"revisionId": %q, "observedAt": "2026-09-30T12:00:02.000Z", "pods": [], "sources": []},
						"meta": {"requestId": %q}
					}`, revision, requestID)
				default:
					t.Errorf("unexpected loopback path %s", path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer srv.Close()

			keyFile := filepath.Join(t.TempDir(), "loopback-key.json")
			if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"loopback-only-probe"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			var stdout bytes.Buffer
			stderr := &runtimeNoticeWriter{err: tc.writerErr}
			cmd := New(&stdout, stderr)
			args := []string{"agent", "runtime", agent, "--namespace", namespace, "--url", srv.URL, "--service-key-file", keyFile, "--ca-bundle=", "--timeout-seconds", "2", "--output", "json"}
			if tc.logs {
				args[1] = "logs"
				args = append(args, "--source", "gateway")
			}
			if tc.explicit {
				args = append(args, "--revision", revision)
			}
			cmd.SetArgs(args)
			gotErr := cmd.Execute()
			if tc.writerErr != nil && !tc.explicit {
				if !errors.Is(gotErr, writeFailure) {
					t.Errorf("Cobra returned %v, want %v", gotErr, writeFailure)
				}
				if stdout.Len() != 0 {
					t.Errorf("stdout = %q, want empty after the fallback notice fails", stdout.String())
				}
			} else {
				if gotErr != nil {
					t.Errorf("Cobra returned %v, want success", gotErr)
				}
				var payload map[string]json.RawMessage
				if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
					t.Errorf("stdout = %q, want JSON: %v", stdout.String(), err)
				} else if tc.logs {
					if string(payload["message"]) != `"startup failed"` {
						t.Errorf("stdout = %q, want the selected revision log record", stdout.String())
					}
				} else if string(payload["pods"]) != "[]" || string(payload["sources"]) != "[]" {
					t.Errorf("stdout = %q, want the selected revision runtime data", stdout.String())
				}
			}
			wantNotice := notice
			if tc.explicit {
				wantNotice = ""
			}
			if got := stderr.attempt.String(); got != wantNotice {
				t.Errorf("attempted stderr = %q, want %q", got, wantNotice)
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(requests, tc.wantRequests) {
				t.Errorf("requests = %v, want %v", requests, tc.wantRequests)
			}
		})
	}
}
