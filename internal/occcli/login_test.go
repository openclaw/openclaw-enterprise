package occcli

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const testCLIToken = "occcli_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func useSessionDirectory(t *testing.T) string {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "occ", "sessions")
	original := sessionDirectoryOverride
	sessionDirectoryOverride = directory
	t.Cleanup(func() { sessionDirectoryOverride = original })
	return directory
}

// cliSignInStub answers the RFC-0019 routes the way the controller does: the token route
// stays pending for `pending` polls (after an optional SLOW_DOWN), then issues once.
type cliSignInStub struct {
	mu            sync.Mutex
	pending       int
	slowDownFirst bool
	denied        bool
	startStatus   int
	polls         int
	startBodies   []map[string]any
	credentials   []string
	loggedOut     bool
}

func (stub *cliSignInStub) serve(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		stub.mu.Lock()
		defer stub.mu.Unlock()
		writer.Header().Set("content-type", "application/json")
		fail := func(status int, code string) {
			writer.WriteHeader(status)
			fmt.Fprintf(writer, `{"error":{"code":%q,"message":"stub"},"meta":{"requestId":"req"}}`, code)
		}
		switch request.URL.Path {
		case "/api/auth/cli/device-authorizations":
			if request.Header.Get("x-api-key") != "" || request.Header.Get("x-occ-cli-session") != "" {
				t.Errorf("start sent a credential")
			}
			if stub.startStatus != 0 {
				fail(stub.startStatus, "NOT_FOUND")
				return
			}
			var body map[string]any
			if err := json.UnmarshalRead(request.Body, &body); err != nil {
				t.Errorf("start body: %v", err)
			}
			stub.startBodies = append(stub.startBodies, body)
			writer.WriteHeader(http.StatusCreated)
			fmt.Fprint(writer, `{"data":{"deviceCode":"device-code-device-code-device-code-devic","userCode":"BCDF-GHJK","verificationUri":"/console/cli-login","interval":5,"expiresIn":600},"meta":{"requestId":"req"}}`)
		case "/api/auth/cli/token":
			stub.polls++
			switch {
			case stub.slowDownFirst && stub.polls == 1:
				fail(http.StatusBadRequest, "SLOW_DOWN")
			case stub.denied:
				fail(http.StatusBadRequest, "ACCESS_DENIED")
			case stub.polls <= stub.pending:
				fail(http.StatusBadRequest, "AUTHORIZATION_PENDING")
			default:
				namespace := ""
				if len(stub.startBodies) > 0 {
					if pin, ok := stub.startBodies[0]["namespaceId"].(string); ok {
						namespace = fmt.Sprintf(`,"namespaceId":%q`, pin)
					}
				}
				fmt.Fprintf(writer, `{"data":{"token":%q,"session":{"id":"cls_1","clientLabel":"occ on host","createdAt":"2026-10-07T10:00:00.000Z","expiresAt":"2999-01-01T00:00:00.000Z"%s},"user":{"id":"u1","email":"person@example.test","name":"Person"}},"meta":{"requestId":"req"}}`, testCLIToken, namespace)
			}
		case "/api/auth/cli-sessions/current":
			if request.Header.Get("x-occ-cli-session") != testCLIToken {
				fail(http.StatusUnauthorized, "UNAUTHENTICATED")
				return
			}
			if request.Method == http.MethodDelete {
				stub.loggedOut = true
				fmt.Fprint(writer, `{"data":{"id":"cls_1","revoked":true},"meta":{"requestId":"req"}}`)
				return
			}
			fmt.Fprint(writer, `{"data":{"id":"cls_1","clientLabel":"occ on host","createdAt":"2026-10-07T10:00:00.000Z","expiresAt":"2999-01-01T00:00:00.000Z","user":{"id":"u1","email":"person@example.test","name":"Person"}},"meta":{"requestId":"req"}}`)
		case "/namespaces":
			stub.credentials = append(stub.credentials, "key="+request.Header.Get("x-api-key")+" cli="+request.Header.Get("x-occ-cli-session"))
			fmt.Fprint(writer, `{"data":[],"meta":{"requestId":"req"}}`)
		default:
			fail(http.StatusNotFound, "NOT_FOUND")
		}
	}))
}

func runOcc(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	command := New(&out, &errOut)
	command.SetArgs(args)
	err := command.ExecuteContext(context.Background())
	return out.String(), errOut.String(), err
}

func TestLoginStoresAPrivatePinnedSessionThatLaterCommandsSend(t *testing.T) {
	directory := useSessionDirectory(t)
	sleeps := recordSleeps(t)
	stub := &cliSignInStub{pending: 2, slowDownFirst: true}
	server := stub.serve(t)
	defer server.Close()

	out, errOut, err := runOcc(t, "login", "--url", server.URL, "--namespace", "ns_11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("occ login: %v", err)
	}
	if !strings.Contains(errOut, server.URL+"/console/cli-login") || !strings.Contains(errOut, "BCDF-GHJK") {
		t.Fatalf("login instructions = %q", errOut)
	}
	if !strings.Contains(out, "person@example.test") || !strings.Contains(out, "ns_11111111-1111-4111-8111-111111111111") {
		t.Fatalf("login output = %q", out)
	}
	// RFC 8628: a SLOW_DOWN adds five seconds to every later poll.
	if got := fmt.Sprint(*sleeps); got != "[5s 10s 10s]" {
		t.Fatalf("poll waits = %s", got)
	}
	if pin := stub.startBodies[0]["namespaceId"]; pin != "ns_11111111-1111-4111-8111-111111111111" {
		t.Fatalf("start pin = %v", pin)
	}

	// 0600 in a 0700 directory, holding the token for this origin only.
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 {
		t.Fatalf("session directory entries = %v, %v", entries, err)
	}
	path := filepath.Join(directory, entries[0].Name())
	if runtime.GOOS != "windows" {
		for file, want := range map[string]os.FileMode{directory: 0o700, path: 0o600} {
			info, err := os.Stat(file)
			if err != nil || info.Mode().Perm() != want {
				t.Fatalf("%s mode = %v, %v; want %v", file, info.Mode().Perm(), err, want)
			}
		}
	}

	if _, _, err := runOcc(t, "namespace", "list", "--url", server.URL); err != nil {
		t.Fatalf("namespace list with the CLI session: %v", err)
	}
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// An explicit service key still wins, so existing scripts are unchanged.
	if _, _, err := runOcc(t, "namespace", "list", "--url", server.URL, "--service-key-file", keyFile); err != nil {
		t.Fatalf("namespace list with a service key: %v", err)
	}
	if got := strings.Join(stub.credentials, " | "); got != "key= cli="+testCLIToken+" | key=test-key cli=" {
		t.Fatalf("credentials sent = %s", got)
	}

	status, _, err := runOcc(t, "auth", "status", "--url", server.URL, "-o", "json")
	if err != nil || !strings.Contains(status, `"source": "cli-session"`) || !strings.Contains(status, `"state": "active"`) {
		t.Fatalf("auth status = %q, %v", status, err)
	}

	out, _, err = runOcc(t, "logout", "--url", server.URL)
	if err != nil || !stub.loggedOut || !strings.Contains(out, "Signed out") {
		t.Fatalf("logout = %q, %v (server saw logout: %v)", out, err, stub.loggedOut)
	}
	if entries, _ := os.ReadDir(directory); len(entries) != 0 {
		t.Fatalf("logout left %v", entries)
	}
	if _, _, err := runOcc(t, "namespace", "list", "--url", server.URL); err == nil || !strings.Contains(err.Error(), "run occ login") {
		t.Fatalf("namespace list after logout: %v", err)
	}
}

func TestLoginExplainsAnOlderControllerAndADenial(t *testing.T) {
	useSessionDirectory(t)
	recordSleeps(t)
	older := &cliSignInStub{startStatus: http.StatusNotFound}
	server := older.serve(t)
	defer server.Close()
	if _, _, err := runOcc(t, "login", "--url", server.URL); err == nil || !strings.Contains(err.Error(), "does not support occ login (HTTP 404)") {
		t.Fatalf("login against an older controller: %v", err)
	}

	denied := &cliSignInStub{denied: true}
	deniedServer := denied.serve(t)
	defer deniedServer.Close()
	if _, _, err := runOcc(t, "login", "--url", deniedServer.URL); err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("denied login: %v", err)
	}
}

func TestSessionFilesAreRefusedWhenSharedLinkedOrForAnotherOrigin(t *testing.T) {
	directory := useSessionDirectory(t)
	origin := "https://occ.example.test"
	session := storedSession{Origin: origin, Token: testCLIToken, SessionID: "cls_1", ExpiresAt: "2999-01-01T00:00:00Z", Email: "person@example.test"}
	if err := saveSession(session); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadSession(origin)
	if err != nil || loaded == nil || loaded.Token != testCLIToken {
		t.Fatalf("load = %+v, %v", loaded, err)
	}
	// A different origin never reads this origin's token.
	if other, err := loadSession("https://evil.example.test"); err != nil || other != nil {
		t.Fatalf("another origin loaded %+v, %v", other, err)
	}
	path, err := sessionPath(origin)
	if err != nil {
		t.Fatal(err)
	}

	// A file whose recorded origin differs from its name's origin is not trusted.
	forged, err := sessionPath("https://evil.example.test")
	if err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(path)
	if err := os.WriteFile(forged, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSession("https://evil.example.test"); err == nil {
		t.Fatal("a session file copied to another origin was accepted")
	}
	if err := os.Remove(forged); err != nil {
		t.Fatal(err)
	}

	if runtime.GOOS == "windows" {
		return
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSession(origin); err == nil || !strings.Contains(err.Error(), "readable by other users") {
		t.Fatalf("group-readable session: %v", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}

	target := filepath.Join(t.TempDir(), "elsewhere.json")
	if err := os.Rename(path, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSession(origin); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked session: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	if err := os.Chmod(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := saveSession(session); err == nil || !strings.Contains(err.Error(), "readable by other users") {
		t.Fatalf("save into a shared directory: %v", err)
	}
}

func TestExpiredStoredSessionIsNotSent(t *testing.T) {
	useSessionDirectory(t)
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("an expired session reached the server")
	}))
	defer server.Close()
	origin, err := canonicalOrigin(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	if err := saveSession(storedSession{Origin: origin, Token: testCLIToken, ExpiresAt: past}); err != nil {
		t.Fatal(err)
	}
	_, _, err = runOcc(t, "namespace", "list", "--url", server.URL)
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired session: %v", err)
	}
	out, _, err := runOcc(t, "auth", "status", "--url", server.URL)
	if err != nil || !strings.Contains(out, "expired") {
		t.Fatalf("auth status = %q, %v", out, err)
	}
}
