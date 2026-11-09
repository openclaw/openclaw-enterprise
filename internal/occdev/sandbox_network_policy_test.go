package occdev

import (
	"context"
	"encoding/json/v2"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const pythonNetworkPolicy = `networkPolicies:
  - name: python-web
    binaries:
      - path: /usr/bin/python3.11
    endpoints:
      - host: example.com
        ports: [443]
        tls: skip
`

func TestSandboxNetworkPolicyRejectsInvalidInputBeforeProvisioning(t *testing.T) {
	repository, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		input, path, code, message string
		yamlError                  bool
	}{
		"unknown root":             {input: "filesystem: {}\n" + pythonNetworkPolicy, yamlError: true},
		"unknown endpoint":         {input: strings.Replace(pythonNetworkPolicy, "tls: skip", "tls: skip\n        hostname: ignored", 1), path: "/policy/networkPolicies/1/endpoints/0", code: "UNKNOWN_FIELD"},
		"unknown binary":           {input: strings.Replace(pythonNetworkPolicy, "path: /usr/bin/python3.11", "path: /usr/bin/python3.11\n        executable: ignored", 1), path: "/policy/networkPolicies/1/binaries/0", code: "UNKNOWN_FIELD"},
		"invalid port":             {input: strings.Replace(pythonNetworkPolicy, "443", "70000", 1), code: "INVALID_VALUE"},
		"invalid TLS":              {input: strings.Replace(pythonNetworkPolicy, "tls: skip", "tls: invalid", 1), path: "/policy/networkPolicies/1/endpoints/0/tls", code: "INVALID_VALUE"},
		"reserved rule":            {input: strings.Replace(pythonNetworkPolicy, "python-web", "workspace-node-enrollment", 1), path: "/policy/networkPolicies/1/name", code: "INVALID_VALUE"},
		"generated rule collision": {input: strings.Replace(pythonNetworkPolicy, "python-web", "source-control", 1), path: "/policy/networkPolicies/1/name", code: "INVALID_VALUE"},
		"duplicate rule":           {input: pythonNetworkPolicy + strings.TrimPrefix(pythonNetworkPolicy, "networkPolicies:\n"), path: "/policy/networkPolicies/2/name", code: "INVALID_VALUE"},
		"multiple documents":       {input: pythonNetworkPolicy + "---\n" + pythonNetworkPolicy, message: "requires one document with a nonempty networkPolicies list"},
		"empty list":               {input: "networkPolicies: []\n", message: "requires one document with a nonempty networkPolicies list"},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "policy.yaml")
			if err := os.WriteFile(path, []byte(tc.input), 0600); err != nil {
				t.Fatal(err)
			}
			state := filepath.Join(root, "state")
			t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "openshell")
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state)
			// Invalid policy must fail before startup creates its owned directory
			// or contacts a container engine. Validation uses the real Driver.
			err := Up(context.Background(), Options{Repository: repository, SandboxNetworkPolicyFile: path})
			if err == nil {
				t.Fatal("startup accepted invalid policy")
			}
			if tc.yamlError {
				var decodeError *yaml.TypeError
				if !errors.As(err, &decodeError) {
					t.Fatalf("startup did not reject the YAML field: %v", err)
				}
			} else if tc.code == "" {
				if !strings.Contains(err.Error(), tc.message) {
					t.Fatalf("startup failed for an unrelated reason: %v", err)
				}
			} else {
				// A missing or incompatible Node runtime also refuses startup. Only
				// the Driver's structured error proves it evaluated this policy.
				payload := strings.TrimPrefix(err.Error(), "Sandbox network policy validation failed: ")
				if cause := errors.Unwrap(err); cause != nil {
					payload = strings.TrimSuffix(payload, ": "+cause.Error())
				}
				var result struct {
					Details []struct {
						Path *string `json:"path"`
						Code string  `json:"code"`
					} `json:"details"`
				}
				if json.Unmarshal([]byte(payload), &result) != nil {
					t.Fatalf("startup did not return a Driver validation error: %v", err)
				}
				matched := false
				for _, detail := range result.Details {
					if detail.Path != nil && *detail.Path == tc.path && detail.Code == tc.code {
						matched = true
						break
					}
				}
				if !matched {
					t.Fatalf("validation error lacks path %q, code %q: %s", tc.path, tc.code, payload)
				}
			}
			if _, err := os.Stat(state); !os.IsNotExist(err) {
				t.Fatalf("invalid policy created development state: %v", err)
			}
		})
	}
}

func TestSandboxNetworkPolicySnapshotPreservesGeneratedRules(t *testing.T) {
	repository, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "policy.yaml")
	if err := os.WriteFile(path, []byte(pythonNetworkPolicy), 0600); err != nil {
		t.Fatal(err)
	}
	r := newRunner(Options{Repository: repository, SandboxNetworkPolicyFile: path})
	policies, err := r.loadSandboxNetworkPolicies(context.Background(), "openshell")
	if err != nil {
		t.Fatal(err)
	}
	// Later file edits must not change the configuration handed to API/worker.
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(pythonNetworkPolicy, "example.com", "example.org")), 0600); err != nil {
		t.Fatal(err)
	}
	state := &developmentState{SandboxDriver: "openshell", SandboxNetworkPolicies: policies, directory: t.TempDir()}
	if err := writeInstallation(state, "runtime@"+profileTestDigest, &openShellDevelopmentAssets{}, "10.43.0.50", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var installation map[string]any
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	rules := installation["drivers"].(map[string]any)["sandbox"].(map[string]any)["configuration"].(map[string]any)["policy"].(map[string]any)["networkPolicies"].([]any)
	if len(rules) != 2 || rules[0].(map[string]any)["name"] != "source-control" || rules[1].(map[string]any)["name"] != "python-web" {
		t.Fatalf("generated and supplied rules were not retained: %v", rules)
	}
	endpoint := rules[1].(map[string]any)["endpoints"].([]any)[0].(map[string]any)
	if endpoint["host"] != "example.com" {
		t.Fatalf("source file edits changed the snapshot: %v", endpoint)
	}
}

// The ceiling must reach both startup consumers without becoming granted network access.
func TestSandboxPolicyCeilingStaysSeparateFromDefaultGrants(t *testing.T) {
	repository, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "ceiling.yaml")
	input := "grants:\n  - id: python-demo\n    binary: /usr/bin/python3.11\n    host: example.org\n    ports: [{from: 443, to: 443}]\n"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	r := newRunner(Options{Repository: repository, SandboxNetworkPolicyCeilingFile: path})
	ceiling, err := r.loadSandboxNetworkPolicyCeiling(context.Background(), "openshell")
	if err != nil {
		t.Fatal(err)
	}
	state := &developmentState{SandboxDriver: "openshell", SandboxNetworkPolicyCeiling: ceiling, directory: t.TempDir()}
	if err := writeInstallation(state, "runtime@"+profileTestDigest, &openShellDevelopmentAssets{}, "10.43.0.50", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var installation map[string]any
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	if len(installation["sandboxNetworkPolicyCeiling"].([]any)) != 1 {
		t.Fatal("delegation ceiling missing from shared startup configuration")
	}
	rules := installation["drivers"].(map[string]any)["sandbox"].(map[string]any)["configuration"].(map[string]any)["policy"].(map[string]any)["networkPolicies"].([]any)
	for _, rule := range rules {
		for _, endpoint := range rule.(map[string]any)["endpoints"].([]any) {
			if endpoint.(map[string]any)["host"] == "example.org" {
				t.Fatal("ceiling accidentally granted default network access")
			}
		}
	}
	// Invalid ceiling input is rejected by the shared contract before infrastructure changes.
	for _, invalid := range []struct {
		input string
		path  string
		code  string
	}{
		// Quote the invalid wildcard so YAML does not treat it as an alias before Driver validation.
		{strings.Replace(input, "example.org", `"**.example.org"`, 1), "/grants/0/host", "INVALID_FORMAT"},
		{strings.Replace(input, "to: 443", "to: 442", 1), "/grants/0/ports/0/to", "INVALID_RANGE"},
		{input + "unknown: true\n", "", ""},
	} {
		if err := os.WriteFile(path, []byte(invalid.input), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := r.loadSandboxNetworkPolicyCeiling(context.Background(), "openshell")
		if err == nil {
			t.Fatal("invalid delegation ceiling accepted")
		}
		if invalid.path != "" && (!strings.Contains(err.Error(), `"path":"`+invalid.path+`"`) || !strings.Contains(err.Error(), `"code":"`+invalid.code+`"`)) {
			t.Fatalf("ceiling diagnostic did not identify its grants field: %v", err)
		}
		if strings.Contains(err.Error(), "/additions") {
			t.Fatalf("ceiling diagnostic exposed the Agent wrapper: %v", err)
		}
	}
}
