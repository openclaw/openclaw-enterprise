package occcli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentDeployOAuthWaitsForRuntimeAttemptThenCompletesAuthorizedDeployment(t *testing.T) {
	restoreDelay := oauthPollDelay
	oauthPollDelay = time.Millisecond
	t.Cleanup(func() { oauthPollDelay = restoreDelay })

	const namespaceID = "ns_00000000-0000-4000-8000-000000000001"
	const agentID = "agt_00000000-0000-4000-8000-000000000001"
	const revisionID = "rev_00000000-0000-4000-8000-000000000001"
	const attemptID = "oauth_00000000-0000-4000-8000-000000000001"
	expiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)

	var calls []string
	authStarts := 0
	authCompleted := false
	completedPolls := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("x-api-key") != "test-service-key" {
			http.Error(response, "missing service key", http.StatusUnauthorized)
			return
		}
		calls = append(calls, request.Method+" "+request.URL.Path)
		response.Header().Set("content-type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy":
			writeEnvelope(response, map[string]any{
				"id":              revisionID,
				"revision":        1,
				"agentId":         agentID,
				"configurationId": "config-oauth",
			})
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
			authStarts++
			if authStarts < 3 {
				writeEnvelope(response, map[string]any{"phase": "preparing"})
				return
			}
			writeEnvelope(response, map[string]any{
				"phase":           "waiting",
				"attemptId":       attemptID,
				"expiresAt":       expiresAt,
				"verificationUrl": "https://auth.openai.example/device",
				"userCode":        "OPEN-CLAW",
			})
		case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
			writeEnvelope(response, map[string]any{
				"phase":     "authorized",
				"attemptId": attemptID,
				"expiresAt": expiresAt,
			})
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth/complete":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode complete body: %v", err)
			}
			if body["attemptId"] != attemptID {
				t.Fatalf("complete body attemptId = %v, want %s", body["attemptId"], attemptID)
			}
			authCompleted = true
			writeEnvelope(response, map[string]any{
				"phase":     "committed",
				"attemptId": attemptID,
				"expiresAt": expiresAt,
			})
		case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID:
			status := "running"
			if authCompleted {
				completedPolls++
				if completedPolls > 1 {
					status = "succeeded"
				}
			}
			writeEnvelope(response, deploymentStatus(namespaceID, agentID, revisionID, status))
		default:
			http.Error(response, "unexpected route", http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	output, errOutput, err := executeCLI(t,
		"--url", server.URL,
		"--service-key-file", serviceKeyFile(t),
		"--namespace", namespaceID,
		"agent", "deploy", agentID,
		"--auth", "oauth",
		"--auth-timeout", "5s",
	)
	if err != nil {
		t.Fatalf("deploy oauth failed: %v\nstderr:\n%s", err, errOutput)
	}
	for _, expected := range []string{
		"OpenAI OAuth authorization required.",
		"Visit: https://auth.openai.example/device",
		"User code: OPEN-CLAW",
		"DEPLOYMENT",
		"succeeded",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("stdout missing %q:\n%s", expected, output)
		}
	}
	if authStarts != 3 {
		t.Fatalf("auth starts = %d, want 3 idempotent start calls", authStarts)
	}
	wantCalls := []string{
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth/complete",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
	}
	if fmt.Sprint(calls) != fmt.Sprint(wantCalls) {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestAgentDeployOAuthUsesSucceededDeploymentWithoutNewConsent(t *testing.T) {
	const namespaceID = "ns_00000000-0000-4000-8000-000000000001"
	const agentID = "agt_00000000-0000-4000-8000-000000000001"
	const revisionID = "rev_00000000-0000-4000-8000-000000000001"

	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.Method+" "+request.URL.Path)
		response.Header().Set("content-type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy":
			writeEnvelope(response, map[string]any{"id": revisionID, "revision": 1, "agentId": agentID})
		case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID:
			writeEnvelope(response, deploymentStatus(namespaceID, agentID, revisionID, "succeeded"))
		default:
			http.Error(response, "unexpected route", http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	output, errOutput, err := executeCLI(t,
		"--url", server.URL,
		"--service-key-file", serviceKeyFile(t),
		"--namespace", namespaceID,
		"agent", "deploy", agentID,
		"--auth", "oauth",
		"--auth-timeout", "5s",
	)
	if err != nil {
		t.Fatalf("deploy oauth failed: %v\nstderr:\n%s", err, errOutput)
	}
	if strings.Contains(output, "User code:") {
		t.Fatalf("stdout printed a consent code for a succeeded deployment:\n%s", output)
	}
	if !strings.Contains(output, "succeeded") {
		t.Fatalf("stdout missing succeeded deployment status:\n%s", output)
	}
	wantCalls := []string{
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
	}
	if fmt.Sprint(calls) != fmt.Sprint(wantCalls) {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestAgentDeployOAuthStatusSuccessWinsStartRace(t *testing.T) {
	restoreDelay := oauthPollDelay
	oauthPollDelay = time.Millisecond
	t.Cleanup(func() { oauthPollDelay = restoreDelay })

	const namespaceID = "ns_00000000-0000-4000-8000-000000000001"
	const agentID = "agt_00000000-0000-4000-8000-000000000001"
	const revisionID = "rev_00000000-0000-4000-8000-000000000001"

	var calls []string
	deploymentGets := 0
	authStarts := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.Method+" "+request.URL.Path)
		response.Header().Set("content-type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy":
			writeEnvelope(response, map[string]any{"id": revisionID, "revision": 1, "agentId": agentID})
		case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID:
			deploymentGets++
			status := "running"
			if deploymentGets > 1 {
				status = "succeeded"
			}
			writeEnvelope(response, deploymentStatus(namespaceID, agentID, revisionID, status))
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
			authStarts++
			writeEnvelope(response, map[string]any{"phase": "preparing"})
		default:
			http.Error(response, "unexpected route", http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	output, errOutput, err := executeCLI(t,
		"--url", server.URL,
		"--service-key-file", serviceKeyFile(t),
		"--namespace", namespaceID,
		"agent", "deploy", agentID,
		"--auth", "oauth",
		"--auth-timeout", "5s",
	)
	if err != nil {
		t.Fatalf("deploy oauth failed: %v\nstderr:\n%s", err, errOutput)
	}
	if strings.Contains(output, "User code:") {
		t.Fatalf("stdout printed a consent code after deployment succeeded:\n%s", output)
	}
	if !strings.Contains(output, "succeeded") {
		t.Fatalf("stdout missing succeeded deployment status:\n%s", output)
	}
	if authStarts != 1 {
		t.Fatalf("auth starts = %d, want exactly one", authStarts)
	}
	wantCalls := []string{
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
	}
	if fmt.Sprint(calls) != fmt.Sprint(wantCalls) {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestAgentDeployOAuthStatusSuccessWinsWaitingResponseRace(t *testing.T) {
	const namespaceID = "ns_00000000-0000-4000-8000-000000000001"
	const agentID = "agt_00000000-0000-4000-8000-000000000001"
	const revisionID = "rev_00000000-0000-4000-8000-000000000001"
	const attemptID = "oauth_00000000-0000-4000-8000-000000000001"
	expiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)

	var calls []string
	deploymentGets := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.Method+" "+request.URL.Path)
		response.Header().Set("content-type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy":
			writeEnvelope(response, map[string]any{"id": revisionID, "revision": 1, "agentId": agentID})
		case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID:
			deploymentGets++
			status := "running"
			if deploymentGets > 1 {
				status = "succeeded"
			}
			writeEnvelope(response, deploymentStatus(namespaceID, agentID, revisionID, status))
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
			writeEnvelope(response, map[string]any{
				"phase":           "waiting",
				"attemptId":       attemptID,
				"expiresAt":       expiresAt,
				"verificationUrl": "https://auth.openai.example/device",
				"userCode":        "OPEN-CLAW",
			})
		default:
			http.Error(response, "unexpected route", http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	output, errOutput, err := executeCLI(t,
		"--url", server.URL,
		"--service-key-file", serviceKeyFile(t),
		"--namespace", namespaceID,
		"agent", "deploy", agentID,
		"--auth", "oauth",
		"--auth-timeout", "5s",
	)
	if err != nil {
		t.Fatalf("deploy oauth failed: %v\nstderr:\n%s", err, errOutput)
	}
	if strings.Contains(output, "User code:") || strings.Contains(output, "OPEN-CLAW") {
		t.Fatalf("stdout printed a raced consent code:\n%s", output)
	}
	if !strings.Contains(output, "succeeded") {
		t.Fatalf("stdout missing succeeded deployment status:\n%s", output)
	}
	wantCalls := []string{
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
	}
	if fmt.Sprint(calls) != fmt.Sprint(wantCalls) {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestAgentDeployOAuthAuthOperationErrorUsesSucceededDeploymentOnly(t *testing.T) {
	restoreDelay := oauthPollDelay
	oauthPollDelay = time.Millisecond
	t.Cleanup(func() { oauthPollDelay = restoreDelay })

	const namespaceID = "ns_00000000-0000-4000-8000-000000000001"
	const agentID = "agt_00000000-0000-4000-8000-000000000001"
	const revisionID = "rev_00000000-0000-4000-8000-000000000001"
	const attemptID = "oauth_00000000-0000-4000-8000-000000000001"

	expiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
	for _, testCase := range []struct {
		name             string
		initialAuthPhase string
		authReadStatus   int
		completeStatus   int
		wantError        string
	}{
		{
			name:             "auth read error after external success",
			initialAuthPhase: "waiting",
			authReadStatus:   http.StatusInternalServerError,
		},
		{
			name:             "complete error after external success",
			initialAuthPhase: "authorized",
			completeStatus:   http.StatusInternalServerError,
		},
		{
			name:             "auth read authorization error is preserved",
			initialAuthPhase: "waiting",
			authReadStatus:   http.StatusUnauthorized,
			wantError:        "OCC operation failed (HTTP 401): UNAUTHORIZED: missing deployment auth access",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			deploymentGets := 0
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("content-type", "application/json")
				switch request.Method + " " + request.URL.Path {
				case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy":
					writeEnvelope(response, map[string]any{"id": revisionID, "revision": 1, "agentId": agentID})
				case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID:
					deploymentGets++
					status := "running"
					if deploymentGets > 3 {
						status = "succeeded"
					}
					writeEnvelope(response, deploymentStatus(namespaceID, agentID, revisionID, status))
				case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
					authResponse := map[string]any{
						"phase":     testCase.initialAuthPhase,
						"attemptId": attemptID,
						"expiresAt": expiresAt,
					}
					if testCase.initialAuthPhase == "waiting" {
						authResponse["verificationUrl"] = "https://auth.openai.example/device"
						authResponse["userCode"] = "OPEN-CLAW"
					}
					writeEnvelope(response, authResponse)
				case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
					writeErrorEnvelope(
						response,
						testCase.authReadStatus,
						"UNAUTHORIZED",
						"missing deployment auth access",
					)
				case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth/complete":
					writeErrorEnvelope(
						response,
						testCase.completeStatus,
						"COMMIT_FAILED",
						"activation was committed by another caller",
					)
				default:
					http.Error(response, "unexpected route", http.StatusNotFound)
				}
			}))
			t.Cleanup(server.Close)

			output, _, err := executeCLI(t,
				"--url", server.URL,
				"--service-key-file", serviceKeyFile(t),
				"--namespace", namespaceID,
				"agent", "deploy", agentID,
				"--auth", "oauth",
				"--auth-timeout", "5s",
			)
			if testCase.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantError) {
					t.Fatalf("error = %v, want %q", err, testCase.wantError)
				}
				return
			}
			if err != nil {
				t.Fatalf("deploy oauth failed: %v", err)
			}
			if !strings.Contains(output, "succeeded") {
				t.Fatalf("stdout missing succeeded deployment status:\n%s", output)
			}
		})
	}
}

func TestAgentDeployOAuthRejectsStructuredOutputBeforeCallingOCC(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	t.Cleanup(server.Close)

	output, _, err := executeCLI(t,
		"--url", server.URL,
		"--service-key-file", serviceKeyFile(t),
		"--namespace", "ns_00000000-0000-4000-8000-000000000001",
		"--output", "json",
		"agent", "deploy", "agt_00000000-0000-4000-8000-000000000001",
		"--auth", "oauth",
	)
	if err == nil || !strings.Contains(err.Error(), "requires table output") {
		t.Fatalf("error = %v, want table-output rejection", err)
	}
	if output != "" {
		t.Fatalf("stdout = %q, want empty", output)
	}
	if called {
		t.Fatalf("OCC server was called before structured-output OAuth rejection")
	}
}

func TestAgentDeployOAuthFailureDoesNotStartAnotherGrantAttempt(t *testing.T) {
	restoreDelay := oauthPollDelay
	oauthPollDelay = time.Millisecond
	t.Cleanup(func() { oauthPollDelay = restoreDelay })

	const namespaceID = "ns_00000000-0000-4000-8000-000000000001"
	const agentID = "agt_00000000-0000-4000-8000-000000000001"
	const revisionID = "rev_00000000-0000-4000-8000-000000000001"
	authStarts := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy":
			writeEnvelope(response, map[string]any{"id": revisionID, "revision": 1, "agentId": agentID})
		case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID:
			writeEnvelope(response, deploymentStatus(namespaceID, agentID, revisionID, "running"))
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
			authStarts++
			writeEnvelope(response, map[string]any{"phase": "failed", "reason": "denied"})
		default:
			http.Error(response, "unexpected route", http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	_, _, err := executeCLI(t,
		"--url", server.URL,
		"--service-key-file", serviceKeyFile(t),
		"--namespace", namespaceID,
		"agent", "deploy", agentID,
		"--auth", "oauth",
		"--auth-timeout", "5s",
	)
	if err == nil || !strings.Contains(err.Error(), "OAuth authorization failed: denied") {
		t.Fatalf("error = %v, want denied OAuth failure", err)
	}
	if authStarts != 1 {
		t.Fatalf("auth starts = %d, want exactly one", authStarts)
	}
}

func TestAgentDeployOAuthKeepsStartErrorWhenDeploymentStillRunning(t *testing.T) {
	const namespaceID = "ns_00000000-0000-4000-8000-000000000001"
	const agentID = "agt_00000000-0000-4000-8000-000000000001"
	const revisionID = "rev_00000000-0000-4000-8000-000000000001"

	var calls []string
	authStarts := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.Method+" "+request.URL.Path)
		response.Header().Set("content-type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy":
			writeEnvelope(response, map[string]any{"id": revisionID, "revision": 1, "agentId": agentID})
		case "GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID:
			writeEnvelope(response, deploymentStatus(namespaceID, agentID, revisionID, "running"))
		case "POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth":
			authStarts++
			writeErrorEnvelope(response, http.StatusConflict, "RESOURCE_CONFLICT", "active deployment is already using OAuth")
		default:
			http.Error(response, "unexpected route", http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	_, _, err := executeCLI(t,
		"--url", server.URL,
		"--service-key-file", serviceKeyFile(t),
		"--namespace", namespaceID,
		"agent", "deploy", agentID,
		"--auth", "oauth",
		"--auth-timeout", "5s",
	)
	if err == nil || !strings.Contains(err.Error(), "RESOURCE_CONFLICT: active deployment is already using OAuth") {
		t.Fatalf("error = %v, want original OAuth start conflict", err)
	}
	if authStarts != 1 {
		t.Fatalf("auth starts = %d, want exactly one", authStarts)
	}
	wantCalls := []string{
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deploy",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
		"POST /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID + "/auth",
		"GET /namespaces/" + namespaceID + "/agents/" + agentID + "/deployments/" + revisionID,
	}
	if fmt.Sprint(calls) != fmt.Sprint(wantCalls) {
		t.Fatalf("calls = %v, want %v", calls, wantCalls)
	}
}

func executeCLI(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command := New(&stdout, &stderr)
	command.SetArgs(args)
	err := command.Execute()
	return stdout.String(), stderr.String(), err
}

func serviceKeyFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(path, []byte(`{"data":{"key":"test-service-key"}}`), 0o600); err != nil {
		t.Fatalf("write service key: %v", err)
	}
	return path
}

func writeEnvelope(response http.ResponseWriter, data any) {
	_ = json.NewEncoder(response).Encode(map[string]any{
		"data": data,
		"meta": map[string]any{"requestId": "req_test"},
	})
}

func writeErrorEnvelope(response http.ResponseWriter, status int, code string, message string) {
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

func deploymentStatus(namespaceID string, agentID string, revisionID string, status string) map[string]any {
	return map[string]any{
		"deploymentId": revisionID,
		"namespaceId":  namespaceID,
		"agentId":      agentID,
		"status":       status,
		"error":        nil,
		"warnings":     []any{},
	}
}
