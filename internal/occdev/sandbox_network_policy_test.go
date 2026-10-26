package occdev

import (
	"context"
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
	for name, input := range map[string]string{
		"unknown root":             "filesystem: {}\n" + pythonNetworkPolicy,
		"unknown endpoint":         strings.Replace(pythonNetworkPolicy, "tls: skip", "tls: skip\n        hostname: ignored", 1),
		"unknown binary":           strings.Replace(pythonNetworkPolicy, "path: /usr/bin/python3.11", "path: /usr/bin/python3.11\n        executable: ignored", 1),
		"invalid port":             strings.Replace(pythonNetworkPolicy, "443", "70000", 1),
		"invalid TLS":              strings.Replace(pythonNetworkPolicy, "tls: skip", "tls: invalid", 1),
		"reserved rule":            strings.Replace(pythonNetworkPolicy, "python-web", "workspace-node-enrollment", 1),
		"generated rule collision": strings.Replace(pythonNetworkPolicy, "python-web", "source-control", 1),
		"duplicate rule":           pythonNetworkPolicy + strings.TrimPrefix(pythonNetworkPolicy, "networkPolicies:\n"),
		"multiple documents":       pythonNetworkPolicy + "---\n" + pythonNetworkPolicy,
		"empty list":               "networkPolicies: []\n",
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "policy.yaml")
			if err := os.WriteFile(path, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			state := filepath.Join(root, "state")
			t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "openshell")
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state)
			// Invalid policy must fail before startup creates its owned directory
			// or contacts a container engine. Validation uses the real Driver.
			if err := Up(context.Background(), Options{Repository: repository, SandboxNetworkPolicyFile: path}); err == nil {
				t.Fatal("startup accepted invalid policy")
			} else if !strings.Contains(err.Error(), "network policy") {
				t.Fatalf("startup failed for an unrelated reason: %v", err)
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
