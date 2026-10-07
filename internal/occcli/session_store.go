package occcli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// storedSession is one occ login session for one OCC origin (RFC-0019). Only the token
// is secret; the rest is the non-secret profile that occ auth status shows.
//
// TODO(rfc-0019-keychain): keep the token in the OS keychain (macOS Keychain, Windows
// Credential Manager, Linux Secret Service) with this file as the fallback. That is
// RFC-0019 unresolved question 7 and needs a new Go dependency; until then the file is
// the only store.
type storedSession struct {
	Origin      string `json:"origin"`
	Token       string `json:"token"`
	SessionID   string `json:"sessionId"`
	ExpiresAt   string `json:"expiresAt"`
	Email       string `json:"email"`
	NamespaceID string `json:"namespaceId,omitempty"`
	CABundle    string `json:"caBundle,omitempty"`
}

// sessionDirectoryOverride is a test seam; empty uses the user configuration directory.
var sessionDirectoryOverride string

// canonicalOrigin is the scheme://host[:port] a session is pinned to. Like the client, it
// accepts only an origin without credentials, a path, a query or a fragment.
func canonicalOrigin(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", fmt.Errorf("OCC URL must be an http or https origin without credentials, a path, a query, or a fragment")
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host), nil
}

func sessionDirectory() (string, error) {
	if sessionDirectoryOverride != "" {
		return sessionDirectoryOverride, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("cannot locate the occ configuration directory: %w", err)
	}
	return filepath.Join(base, "occ", "sessions"), nil
}

func sessionPath(origin string) (string, error) {
	directory, err := sessionDirectory()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(origin))
	return filepath.Join(directory, hex.EncodeToString(digest[:16])+".json"), nil
}

// privateMode refuses a file or directory that is a symlink, not of the expected kind,
// or reachable by the group or others. Windows has no such mode bits to check.
func privateMode(path string, info fs.FileInfo, directory bool) error {
	if info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("refusing %s: it is a symlink", path)
	}
	if directory != info.IsDir() || (!directory && !info.Mode().IsRegular()) {
		return fmt.Errorf("refusing %s: unexpected file type", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("refusing %s: it is readable by other users (mode %04o); remove it and run occ login", path, info.Mode().Perm())
	}
	return nil
}

func ensureSessionDirectory() (string, error) {
	directory, err := sessionDirectory()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("cannot create %s: %w", directory, err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", fmt.Errorf("cannot inspect %s: %w", directory, err)
	}
	if err := privateMode(directory, info, true); err != nil {
		return "", err
	}
	return directory, nil
}

// loadSession returns the stored session for origin, or nil when there is none.
func loadSession(origin string) (*storedSession, error) {
	path, err := sessionPath(origin)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot inspect %s: %w", path, err)
	}
	if err := privateMode(path, info, false); err != nil {
		return nil, err
	}
	directoryInfo, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, fmt.Errorf("cannot inspect %s: %w", filepath.Dir(path), err)
	}
	if err := privateMode(filepath.Dir(path), directoryInfo, true); err != nil {
		return nil, err
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", path, err)
	}
	var session storedSession
	if err := json.Unmarshal(contents, &session); err != nil {
		return nil, fmt.Errorf("invalid session file %s; run occ logout and occ login", path)
	}
	// Origin pinning: a token is only ever sent to the origin that issued it.
	if session.Origin != origin || !strings.HasPrefix(session.Token, "occcli_") ||
		strings.ContainsAny(session.Token, "\r\n") {
		return nil, fmt.Errorf("invalid session file %s; run occ logout and occ login", path)
	}
	return &session, nil
}

// saveSession writes the session atomically: a private temporary file renamed into place.
func saveSession(session storedSession) error {
	directory, err := ensureSessionDirectory()
	if err != nil {
		return err
	}
	path, err := sessionPath(session.Origin)
	if err != nil {
		return err
	}
	contents, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("cannot encode the session: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".session-*")
	if err != nil {
		return fmt.Errorf("cannot write the session: %w", err)
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		temporary.Close()
		return fmt.Errorf("cannot write the session: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return fmt.Errorf("cannot write the session: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("cannot write the session: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("cannot write the session: %w", err)
	}
	return nil
}

func removeSession(origin string) error {
	path, err := sessionPath(origin)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("cannot remove %s: %w", path, err)
	}
	return nil
}

// expired reports whether the stored expiry has passed. An unparsable expiry counts as
// expired, so occ asks for a new login instead of sending a doubtful token.
func (session *storedSession) expired(now time.Time) bool {
	expiresAt, err := time.Parse(time.RFC3339Nano, session.ExpiresAt)
	return err != nil || !now.Before(expiresAt)
}
