package occdev

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBootstrapCredentialsArePrivateAndNotOverwritten(t *testing.T) {
	state := &developmentState{directory: t.TempDir()}
	r := newRunner(Options{Repository: t.TempDir()})
	r.env["OPENCLAW_DEV_PASSWORD"] = " password with spaces "
	if err := r.prepareBootstrapCredentials(state); err != nil {
		t.Fatal(err)
	}
	inputs := map[string][]byte{}
	for _, name := range []string{"initial-admin-password", "initial-admin-service-key", "bootstrap-client-key.json", "mount-admin-password", "mount-admin-service-key"} {
		path := filepath.Join(state.directory, name)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("%s mode = %o", name, info.Mode().Perm())
		}
		inputs[name], err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
	}
	if string(inputs["initial-admin-password"]) != " password with spaces " {
		t.Fatal("password spaces were changed")
	}
	key := string(inputs["initial-admin-service-key"])
	material, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(key, "occ_"))
	if !strings.HasPrefix(key, "occ_") || err != nil || len(material) != 32 {
		t.Fatal("invalid generated service key format")
	}
	var clientKey map[string]any
	if err := json.Unmarshal(inputs["bootstrap-client-key.json"], &clientKey); err != nil {
		t.Fatal(err)
	}
	if len(clientKey) != 1 || clientKey["data"].(map[string]any)["key"] != key {
		t.Fatal("client key must contain only the precreated data.key, not invented issuance metadata")
	}
	for name, file := range map[string]string{"OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE": "mount-admin-password", "OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE": "mount-admin-service-key"} {
		if r.env[name] != filepath.Join(state.directory, file) {
			t.Fatalf("%s does not identify its retained input", name)
		}
	}
	// A second attempt must not rotate credentials left by a partial or failed startup.
	r.env["OPENCLAW_DEV_PASSWORD"] = "different password"
	if err := r.prepareBootstrapCredentials(state); err == nil {
		t.Fatal("existing inputs were replaced")
	}
	for name, before := range inputs {
		after, err := os.ReadFile(filepath.Join(state.directory, name))
		if err != nil || string(after) != string(before) {
			t.Fatalf("retained input %s changed", name)
		}
	}
}

func TestBootstrapExportsOnlyAfterInstallationVerification(t *testing.T) {
	for _, scenario := range []string{"authorized", "rejected", "missing Installation ID"} {
		t.Run(scenario, func(t *testing.T) {
			state := &developmentState{directory: t.TempDir()}
			state.KeyPath = filepath.Join(state.directory, "exported.json")
			r := newRunner(Options{Repository: t.TempDir()})
			if err := r.prepareBootstrapCredentials(state); err != nil {
				t.Fatal(err)
			}
			key, err := os.ReadFile(r.env["OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE"])
			if err != nil {
				t.Fatal(err)
			}
			// This transport fixture proves the launcher uses the retained key and API
			// identity; it does not establish controller authentication or IAM behavior.
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Method != http.MethodGet || req.URL.Path != "/installation" || req.Header.Get("x-api-key") != string(key) {
					t.Error("incorrect Installation verification request")
				}
				w.Header().Set("Content-Type", "application/json")
				if scenario == "rejected" {
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = w.Write([]byte(`{"error":{"code":"UNAUTHENTICATED","message":"rejected"},"meta":{"requestId":"req_fixture"}}`))
					return
				}
				if scenario == "missing Installation ID" {
					_, _ = w.Write([]byte(`{"data":{},"meta":{"requestId":"req_fixture"}}`))
					return
				}
				_, _ = w.Write([]byte(`{"data":{"id":"ins_00000000-0000-4000-8000-000000000001"},"meta":{"requestId":"req_fixture"}}`))
			}))
			defer server.Close()
			id, _, err := r.verifyBootstrapKey(context.Background(), state, server.URL)
			if scenario != "authorized" {
				if err == nil {
					t.Fatal("unverified key was accepted")
				}
				if scenario == "missing Installation ID" && !strings.Contains(err.Error(), "invalid Installation ID") {
					t.Fatalf("expected missing Installation ID rejection, got %v", err)
				}
				if _, err := os.Stat(state.KeyPath); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("unverified key was exported: %v", err)
				}
				if state.InstallationID != "" {
					t.Fatal("unverified Installation identity was saved")
				}
				return
			}
			if err != nil || id != "ins_00000000-0000-4000-8000-000000000001" {
				t.Fatalf("Installation verification: id=%q err=%v", id, err)
			}
			persisted, err := os.ReadFile(filepath.Join(state.directory, "state.json"))
			if err != nil {
				t.Fatal(err)
			}
			var saved developmentState
			if err := json.Unmarshal(persisted, &saved); err != nil || saved.InstallationID != id {
				t.Fatal("confirmed Installation identity was not saved for later helpers")
			}
			exported, err := os.ReadFile(state.KeyPath)
			if err != nil {
				t.Fatal(err)
			}
			source, err := os.ReadFile(filepath.Join(state.directory, "bootstrap-client-key.json"))
			if err != nil {
				t.Fatal(err)
			}
			if string(exported) != string(source) {
				t.Fatal("export changed the precreated credential")
			}
		})
	}
}
