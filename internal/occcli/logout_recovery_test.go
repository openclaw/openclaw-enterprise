package occcli

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLogoutRecoversInvalidSessionWithoutSendingIt(t *testing.T) {
	const marker = "synthetic-session-marker"
	tests := []struct {
		name     string
		contents func(string) string
	}{
		{"malformed", func(string) string { return `{"token":"` + marker }},
		{"empty", func(string) string { return `{}` }},
		{"wrong origin", func(string) string { return `{"origin":"https://other.example.test","token":"occcli_` + marker + `"}` }},
		{"wrong token", func(origin string) string { return fmt.Sprintf(`{"origin":%q,"token":%q}`, origin, marker) }},
		{"newline in token", func(origin string) string {
			return fmt.Sprintf(`{"origin":%q,"token":%q}`, origin, "occcli_"+marker+"\n")
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			directory := useSessionDirectory(t)
			requests := make(chan struct{}, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				select {
				case requests <- struct{}{}:
				default:
				}
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer server.Close()
			if err := os.MkdirAll(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			path, err := sessionPath(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(tc.contents(server.URL)), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := runOcc(t, "auth", "status", "--url", server.URL); err == nil {
				t.Fatal("auth status accepted an invalid session")
			}
			if _, err := os.Lstat(path); err != nil {
				t.Fatalf("auth status changed the invalid session: %v", err)
			}
			other := storedSession{Origin: "https://other.example.test", Token: testCLIToken}
			if err := saveSession(other); err != nil {
				t.Fatal(err)
			}
			out, errOut, err := runOcc(t, "logout", "--url", server.URL)
			if err == nil {
				t.Fatal("logout did not report that remote sign-out was unconfirmed")
			}
			message := out + errOut + err.Error()
			if strings.Contains(message, marker) {
				t.Fatal("logout exposed the invalid session contents")
			}
			if !strings.Contains(message, "removed the invalid local session") || !strings.Contains(message, "could not confirm") {
				t.Fatalf("logout did not distinguish local cleanup from remote sign-out: %q", message)
			}
			if _, err := os.Lstat(path); !os.IsNotExist(err) {
				t.Fatalf("invalid session remains: %v", err)
			}
			if got, err := loadSession(other.Origin); err != nil || got == nil || got.Token != other.Token {
				t.Fatalf("another origin's session was changed: %v", err)
			}
			if out, _, err := runOcc(t, "logout", "--url", server.URL); err != nil || !strings.Contains(out, "Not signed in") {
				t.Fatalf("repeated logout = %q, %v", out, err)
			}
			select {
			case <-requests:
				t.Fatal("logout sent a request for an invalid session")
			default:
			}
		})
	}
}

func TestLogoutRefusesUnsafeSessionFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "shared file", "shared directory"} {
		t.Run(kind, func(t *testing.T) {
			if runtime.GOOS == "windows" && kind != "symlink" {
				t.Skip("POSIX mode checks are not used on Windows")
			}
			directory := useSessionDirectory(t)
			if err := os.MkdirAll(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			origin := "http://127.0.0.1:9"
			path, err := sessionPath(origin)
			if err != nil {
				t.Fatal(err)
			}
			target := path
			if kind == "symlink" {
				target = filepath.Join(directory, "target")
			}
			if err := os.WriteFile(target, []byte("not a session"), 0o600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "symlink":
				if err := os.Symlink(target, path); err != nil {
					t.Skipf("symlink unavailable: %v", err)
				}
			case "shared file":
				if err := os.Chmod(path, 0o644); err != nil {
					t.Fatal(err)
				}
			case "shared directory":
				if err := os.Chmod(directory, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			out, _, err := runOcc(t, "logout", "--url", origin)
			if err == nil || strings.Contains(out, "Signed out") || strings.Contains(err.Error(), "removed the invalid local session") {
				t.Fatalf("unsafe session was not refused: %q, %v", out, err)
			}
			if _, err := os.Lstat(path); err != nil {
				t.Fatalf("unsafe session path changed: %v", err)
			}
			if contents, err := os.ReadFile(target); err != nil || string(contents) != "not a session" {
				t.Fatalf("unsafe session target changed: %v", err)
			}
		})
	}
}

func TestInvalidSessionCleanupRefusesObservedReplacement(t *testing.T) {
	directory := useSessionDirectory(t)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	origin := "https://occ.example.test"
	path, err := sessionPath(origin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = loadSession(origin)
	var invalid *invalidSessionError
	if !errors.As(err, &invalid) {
		t.Fatalf("load did not classify invalid contents: %v", err)
	}
	replacement := storedSession{Origin: origin, Token: testCLIToken}
	if err := saveSession(replacement); err != nil {
		t.Fatal(err)
	}
	if removed, err := removeInvalidSession(invalid); err == nil || removed {
		t.Fatalf("cleanup accepted a replaced session: removed=%v, err=%v", removed, err)
	}
	if got, err := loadSession(origin); err != nil || got == nil || got.Token != replacement.Token {
		t.Fatalf("replacement session was changed: %v", err)
	}
}

func TestInvalidSessionCleanupRefusesReplacedDirectory(t *testing.T) {
	directory := useSessionDirectory(t)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	origin := "https://occ.example.test"
	path, err := sessionPath(origin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = loadSession(origin)
	var invalid *invalidSessionError
	if !errors.As(err, &invalid) {
		t.Fatalf("load did not classify invalid contents: %v", err)
	}
	if err := os.Rename(directory, directory+"-previous"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if removed, err := removeInvalidSession(invalid); err == nil || removed {
		t.Fatalf("cleanup accepted a replaced directory: removed=%v, err=%v", removed, err)
	}
	if contents, err := os.ReadFile(path); err != nil || string(contents) != "replacement" {
		t.Fatalf("replacement directory contents changed: %v", err)
	}
}
