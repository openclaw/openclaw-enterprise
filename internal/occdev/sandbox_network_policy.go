package occdev

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"go.yaml.in/yaml/v3"
)

// loadSandboxNetworkPolicies snapshots the file and asks the selected Driver to
// validate the effective configuration before any development resources exist.
func (r *runner) loadSandboxNetworkPolicies(ctx context.Context, sandboxDriver string) ([]any, error) {
	if r.opts.SandboxNetworkPolicyFile == "" {
		return nil, nil
	}
	if sandboxDriver != "openshell" {
		return nil, fmt.Errorf("--sandbox-network-policy-file requires the OpenShell Sandbox Driver")
	}
	file, err := os.Open(r.opts.SandboxNetworkPolicyFile)
	if err != nil {
		return nil, fmt.Errorf("read Sandbox network policy file: %w", err)
	}
	defer file.Close()
	const limit = 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || len(data) > limit {
		return nil, fmt.Errorf("Sandbox network policy file must be readable and at most 1 MiB")
	}
	var document struct {
		NetworkPolicies []any `yaml:"networkPolicies"`
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("invalid Sandbox network policy file: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF || len(document.NetworkPolicies) == 0 {
		return nil, fmt.Errorf("Sandbox network policy file requires one document with a nonempty networkPolicies list")
	}
	state := &developmentState{SandboxNetworkPolicies: document.NetworkPolicies}
	configuration := openShellInstallationConfiguration(state, nil, nil)["configuration"]
	input, err := json.Marshal(configuration)
	if err != nil {
		return nil, fmt.Errorf("invalid Sandbox network policy values: %w", err)
	}
	command := r.command(ctx, "node", filepath.Join(r.opts.Repository, "scripts", "validate-sandbox-network-policy.mjs"))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("Sandbox network policy validation failed: %s: %w", bytes.TrimSpace(output), err)
	}
	return document.NetworkPolicies, nil
}

// A ceiling authorizes future requests; it never becomes a default network grant.
func (r *runner) loadSandboxNetworkPolicyCeiling(ctx context.Context, sandboxDriver string) ([]any, error) {
	if r.opts.SandboxNetworkPolicyCeilingFile == "" {
		return nil, nil
	}
	if sandboxDriver == "none" {
		return nil, fmt.Errorf("--sandbox-network-policy-ceiling-file requires a Sandbox Driver")
	}
	file, err := os.Open(r.opts.SandboxNetworkPolicyCeilingFile)
	if err != nil {
		return nil, fmt.Errorf("read Sandbox delegation ceiling: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 {
		return nil, fmt.Errorf("Sandbox delegation ceiling must be readable and at most 1 MiB")
	}
	var document struct {
		Grants []any `yaml:"grants"`
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("invalid Sandbox delegation ceiling: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF || len(document.Grants) == 0 {
		return nil, fmt.Errorf("Sandbox delegation ceiling requires one document with a nonempty grants list")
	}
	input, err := json.Marshal(document.Grants)
	if err != nil {
		return nil, err
	}
	command := r.command(ctx, "node", filepath.Join(r.opts.Repository, "scripts", "validate-sandbox-network-policy.mjs"), "--ceiling")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("Sandbox delegation ceiling validation failed: %s: %w", bytes.TrimSpace(output), err)
	}
	return document.Grants, nil
}
