package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if arguments, ok := os.LookupEnv("OCC_TEST_RUN_MAIN"); ok {
		os.Args = append([]string{"occ"}, strings.Fields(arguments)...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// occ dev up on the Docker profile runs scripts/dev-up; its exit status is the
// command's, so callers can tell success, failure and the script's usage
// errors (exit 2) apart.
func TestDevUpDockerExitsWithTheStartupScriptStatus(t *testing.T) {
	for _, code := range []int{0, 3} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			repository := t.TempDir()
			for path, contents := range map[string]string{
				"go.mod":         "module github.com/openclaw/openclaw-enterprise\n",
				"compose.yaml":   "services: {}\n",
				"scripts/dev-up": "echo started\nexit " + strconv.Itoa(code) + "\n",
			} {
				path = filepath.Join(repository, path)
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			process := exec.Command(executable)
			process.Dir = repository
			process.Env = append(os.Environ(), "OCC_TEST_RUN_MAIN=dev up", "OCC_DEVELOPMENT_COMPUTE_DRIVER=docker")
			var stderr strings.Builder
			process.Stderr = &stderr
			err = process.Run()
			status := 0
			var exited *exec.ExitError
			if errors.As(err, &exited) {
				status = exited.ExitCode()
			} else if err != nil {
				t.Fatal(err)
			}
			if status != code {
				t.Fatalf("occ dev up exited %d, want the script's %d; stderr: %q", status, code, stderr.String())
			}
			if stderr.String() != "" {
				t.Fatalf("occ dev up added to the script's diagnostics: %q", stderr.String())
			}
		})
	}
}

// Exercise main and the real HTTP client: whitespace in a valid API response
// must not break consumers that parse one JSON value per output line.
func TestAgentLogsJSONLines(t *testing.T) {
	const namespace = "ns_00000000-0000-4000-8000-000000000001"
	const agent = "agt_00000000-0000-4000-8000-000000000001"
	const revision = "rev_00000000-0000-4000-8000-000000000001"
	const record = `{"type":"line","time":"2026-09-30T12:00:01.000Z","stream":{"source":"gateway"},"contentClass":"operational","kind":"openclaw","level":"info","message":"startup complete","fields":{"count":9007199254740993,"fraction":1.2300},"extension":"preserved"}`
	for _, mode := range []string{"compact", "indented", "refused"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/namespaces/"+namespace+"/agents/"+agent+"/deployments/"+revision+"/runtime/logs" || r.URL.RawQuery != "source=gateway&tailLines=200" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if mode == "refused" {
					w.WriteHeader(http.StatusForbidden)
					fmt.Fprint(w, `{"error":{"code":"FORBIDDEN","message":"synthetic refusal"}}`)
					return
				}
				payload := fmt.Sprintf(`{"data":{"revisionId":%q,"source":"gateway","stream":{"source":"gateway"},"observedAt":"2026-09-30T12:00:02.000Z","records":[%s,%s],"withheld":0,"truncated":false,"cursor":null},"meta":{"requestId":"synthetic-request"}}`, revision, record, record)
				if mode == "indented" {
					var formatted bytes.Buffer
					if err := json.Indent(&formatted, []byte(payload), "", "  "); err != nil {
						t.Error(err)
						return
					}
					payload = formatted.String()
				}
				fmt.Fprint(w, payload)
			}))
			defer server.Close()
			key := filepath.Join(t.TempDir(), "key.json")
			if err := os.WriteFile(key, []byte(`{"data":{"key":"synthetic-loopback-only"}}`), 0600); err != nil {
				t.Fatal(err)
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			process := exec.Command(executable)
			args := "--url " + server.URL + " --service-key-file " + key + " --ca-bundle= --timeout-seconds 5 --namespace " + namespace + " agent logs " + agent + " --revision " + revision + " --source gateway -o json"
			process.Env = append(os.Environ(), "OCC_TEST_RUN_MAIN="+args)
			var out, stderr bytes.Buffer
			process.Stdout, process.Stderr = &out, &stderr
			err = process.Run()
			if mode == "refused" {
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 1 || out.Len() != 0 || !strings.Contains(stderr.String(), "FORBIDDEN") {
					t.Fatalf("refusal: %v stdout=%q stderr=%q", err, out.String(), stderr.String())
				}
				return
			}
			if err != nil || stderr.Len() != 0 {
				t.Fatalf("logs: %v stderr=%q", err, stderr.String())
			}
			lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
			if len(lines) != 2 {
				t.Fatalf("got %d output lines for two API records", len(lines))
			}
			for _, line := range lines {
				if !json.Valid([]byte(line)) {
					t.Fatalf("invalid JSON line: %q", line)
				}
				// Compare the full record, including unknown fields and numeric spelling:
				// decoding through float64 or the display struct would lose API data.
				if line != record {
					t.Fatalf("record changed: %s", line)
				}
			}
		})
	}
}
