package occdev

import (
	"context"
	"crypto/sha256"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

func (r *runner) clusterExists(ctx context.Context, name string) (bool, error) {
	data, err := r.output(ctx, "k3d", "cluster", "list", "-o", "json")
	if err != nil {
		return false, err
	}
	var clusters []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &clusters); err != nil {
		return false, fmt.Errorf("invalid k3d cluster inventory: %w", err)
	}
	for _, cluster := range clusters {
		if cluster.Name == name {
			return true, nil
		}
	}
	return false, nil
}
func (r *runner) writeKubeconfigs(ctx context.Context, s *developmentState) error {
	data, err := r.output(ctx, "k3d", "kubeconfig", "get", s.Cluster)
	if err != nil {
		return err
	}
	host := filepath.Join(s.directory, "kubeconfig")
	if err := exclusiveWrite(host, data, 0600); err != nil {
		return err
	}
	contextName := "k3d-" + s.Cluster
	if _, err := r.output(ctx, "kubectl", "--kubeconfig", host, "--context", contextName, "get", "--raw=/version"); err != nil {
		return err
	}
	var config map[string]any
	if err := yaml.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("invalid k3d kubeconfig: %w", err)
	}
	contexts, _ := config["contexts"].([]any)
	clusterName := ""
	for _, item := range contexts {
		entry, _ := item.(map[string]any)
		if entry["name"] == contextName {
			value, _ := entry["context"].(map[string]any)
			clusterName, _ = value["cluster"].(string)
		}
	}
	if clusterName == "" {
		return fmt.Errorf("k3d kubeconfig is missing its expected context")
	}
	clusters, _ := config["clusters"].([]any)
	found := false
	for _, item := range clusters {
		entry, _ := item.(map[string]any)
		if entry["name"] == clusterName {
			value, ok := entry["cluster"].(map[string]any)
			if !ok {
				return fmt.Errorf("invalid kubeconfig cluster")
			}
			value["server"] = "https://k3d-" + s.Cluster + "-serverlb:6443"
			value["tls-server-name"] = "k3d-" + s.Cluster + "-serverlb"
			found = true
		}
	}
	if !found {
		return fmt.Errorf("k3d kubeconfig is missing its expected cluster")
	}
	data, err = yaml.Marshal(config)
	if err != nil {
		return err
	}
	// The directory stays 0700; these two files are individually mounted into non-root containers.
	return exclusiveWrite(filepath.Join(s.directory, "container-kubeconfig"), data, 0644)
}

var imageDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

func (r *runner) importRuntime(ctx context.Context, s *developmentState) (string, error) {
	image := r.setting("OCC_KUBERNETES_RUNTIME_IMAGE", "openclaw-enterprise-runtime:kubernetes-quickstart")
	if r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] != "" {
		if _, err := r.output(ctx, r.engine, "image", "inspect", image); err != nil {
			return "", fmt.Errorf("explicitly selected runtime image must already exist locally: %s", image)
		}
	} else {
		if err := r.run(ctx, r.engine, "build", "-f", "deploy/runtime/Dockerfile", "--tag", image, "."); err != nil {
			return "", err
		}
	}
	return r.importDevelopmentImage(ctx, s, image)
}

func (r *runner) importDevelopmentImage(ctx context.Context, s *developmentState, image string) (result string, resultErr error) {
	selected := image
	staged := false
	if strings.Contains(image, "@") {
		staged = true
		digest := sha256.Sum256([]byte(image))
		selected = fmt.Sprintf("openclaw-development/import-%x:%s", digest[:6], s.Cluster)
		if _, err := r.output(ctx, r.engine, "image", "inspect", selected); err == nil {
			return "", fmt.Errorf("development staging image already exists: %s", selected)
		}
		if err := r.run(ctx, r.engine, "tag", image, selected); err != nil {
			return "", err
		}
		defer func() {
			if _, err := r.output(context.WithoutCancel(ctx), r.engine, "image", "rm", selected); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("remove development staging image: %w", err))
			}
		}()
	}
	if staged {
		platformData, err := r.output(ctx, r.engine, "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", selected)
		if err != nil {
			return "", err
		}
		platform := string(platformData)
		if !strings.HasPrefix(platform, "linux/") {
			return "", fmt.Errorf("development image must contain a Linux platform: %s", image)
		}
		archive := filepath.Join(s.directory, "development-import.tar")
		defer func() {
			if err := os.Remove(archive); err != nil && !os.IsNotExist(err) {
				resultErr = errors.Join(resultErr, fmt.Errorf("remove development image archive: %w", err))
			}
		}()
		saveArgs := []string{"image", "save"}
		if r.engine == "docker" {
			saveArgs = append(saveArgs, "--platform", platform)
		}
		saveArgs = append(saveArgs, "--output", archive, selected)
		if err := r.run(ctx, r.engine, saveArgs...); err != nil {
			return "", err
		}
		if err := r.run(ctx, "k3d", "image", "import", "--mode", "direct", archive, "-c", s.Cluster); err != nil {
			return "", err
		}
	} else if err := r.run(ctx, "k3d", "image", "import", selected, "-c", s.Cluster); err != nil {
		return "", err
	}
	server := "k3d-" + s.Cluster + "-server-0"
	data, err := r.output(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "list")
	if err != nil {
		return "", err
	}
	normalized := selected
	first, _, _ := strings.Cut(normalized, "/")
	if !strings.Contains(normalized, "/") {
		normalized = "docker.io/library/" + normalized
	} else if !strings.ContainsAny(first, ".:") && first != "localhost" {
		normalized = "docker.io/" + normalized
	}
	if !strings.Contains(normalized, "@") && !strings.Contains(normalized[strings.LastIndex(normalized, "/")+1:], ":") {
		normalized += ":latest"
	}
	imported, digest := "", ""
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && (fields[0] == selected || fields[0] == normalized) {
			if imported != "" && digest != fields[2] {
				return "", fmt.Errorf("ambiguous imported image %s", selected)
			}
			imported, digest = fields[0], fields[2]
		}
	}
	if !imageDigest.MatchString(digest) {
		return "", fmt.Errorf("could not resolve imported image digest for %s", selected)
	}
	repository, _, _ := strings.Cut(normalized, "@")
	if prefix, suffix, found := strings.CutLast(repository, ":"); found && !strings.Contains(suffix, "/") {
		repository = prefix
	}
	reference := repository + "@" + digest
	if reference != imported {
		if err := r.run(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "tag", imported, reference); err != nil {
			return "", err
		}
	}
	return reference, nil
}

// The local profile trusts only Pod loopback; first-agent verifies model access
// with the separate loopback password. Routed installations supply Envoy source CIDRs.
func writeInstallation(s *developmentState, reference string, openShell *openShellDevelopmentAssets) error {
	auth := map[string]any{"mode": "kubeconfig", "kubeconfigPath": "/run/openclaw-development/kubeconfig", "context": "k3d-" + s.Cluster}
	gatewayClientNamespace := "default"
	if s.DeploymentMode == "k3d" {
		auth = map[string]any{"mode": "inCluster"}
		gatewayClientNamespace = s.PlatformNamespace
	}
	resources := map[string]any{"requests": map[string]string{"cpu": "100m", "memory": "256Mi"}, "limits": map[string]string{"cpu": "2", "memory": "2Gi"}}
	config := map[string]any{
		"occ": map[string]string{"cluster": s.Cluster}, "backend": []any{},
		"drivers": map[string]any{
			"configuration": map[string]any{"id": "config-kubernetes", "configuration": map[string]any{"authentication": auth}},
			"iam":           map[string]any{"id": "native-iam", "configuration": map[string]any{}},
			"secret":        map[string]any{"id": "secret-kubernetes", "configuration": map[string]any{"authentication": auth}},
			"compute": map[string]any{"id": "compute-kubernetes", "configuration": map[string]any{
				"authentication": auth, "images": map[string]any{"gateway": reference, "agent": reference, "requireImmutableDigest": true},
				"resources":                   map[string]any{"gateway": resources, "agent": resources, "namespace": map[string]any{"quota": map[string]string{"pods": "10"}, "containerDefaults": resources}},
				"network":                     map[string]any{"dns": map[string]any{"namespace": "kube-system", "podLabels": map[string]string{"k8s-app": "kube-dns"}}, "gatewayPort": 8080, "gatewayTrustedProxyCidrs": []string{"127.0.0.1/32"}, "gatewayClients": []any{map[string]any{"namespace": gatewayClientNamespace, "podLabels": map[string]string{"app.kubernetes.io/name": "occ-kubernetes-dev-client"}}}},
				"servicePrincipalCredentials": map[string]any{"mode": "projectedServiceAccountToken", "audience": "openclaw-enterprise", "expirationSeconds": 900},
				"runtime":                     map[string]any{"gatewayStorageClassName": "local-path", "transportSecretPrefix": "openclaw-agent-transport", "gatewayNodeSelector": map[string]string{"kubernetes.io/hostname": "k3d-" + s.Cluster + "-server-0"}},
			}},
		},
	}
	if s.SandboxDriver == "openshell" {
		if openShell == nil {
			return fmt.Errorf("OpenShell development assets are required")
		}
		config["drivers"].(map[string]any)["sandbox"] = openShellInstallationConfiguration(s, openShell.workspaceResources)
	}
	data, err := yaml.Marshal(config)
	if err != nil {
		return err
	}
	return exclusiveWrite(filepath.Join(s.directory, "installation.yaml"), data, 0644)
}

func openShellInstallationConfiguration(s *developmentState, workspaceResources []any) map[string]any {
	gatewayNamespace := openShellGatewayNamespace
	endpoint := fmt.Sprintf("http://k3d-%s-server-0:%d", s.Cluster, openShellNodePort)
	if s.DeploymentMode == "k3d" {
		gatewayNamespace = s.PlatformNamespace
		endpoint = fmt.Sprintf("http://%s.%s.svc.cluster.local:8080", openShellGatewayService, gatewayNamespace)
	}
	gatewayLabels := map[string]string{
		"app.kubernetes.io/name":     "openshell",
		"app.kubernetes.io/instance": openShellGatewayService,
	}
	return map[string]any{
		"id": "sandbox-openshell-development",
		"configuration": map[string]any{
			"gateway": map[string]any{
				"endpoint":      endpoint,
				"workspaceMode": "operator",
				"operatorNamespaceLabels": map[string]string{
					openShellOperatorNamespaceLabel: openShellOperatorNamespaceValue,
				},
				"operatorWorkspaceResources": workspaceResources,
				"networkPolicyResources": []any{
					map[string]any{
						"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
						"metadata": map[string]string{"name": "allow-openshell-sandbox-callback"},
						"spec": map[string]any{
							"podSelector": map[string]any{"matchLabels": map[string]string{
								openShellManagedByLabel:    openShellManagedByValue,
								openShellBoundaryRoleLabel: openShellSupervisorRole,
							}},
							"policyTypes": []string{"Egress"},
							"egress": []any{map[string]any{"to": []any{map[string]any{
								"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": gatewayNamespace}},
								"podSelector":       map[string]any{"matchLabels": gatewayLabels},
							}}, "ports": []any{map[string]any{"protocol": "TCP", "port": 8080}}}},
						},
					},
				},
			},
			"kubernetes": map[string]any{
				"runtimeClassName": openShellRuntimeClass,
				"serviceAccount":   map[string]string{"mode": "gatewayConfigured"},
				"sandboxDataMount": map[string]any{"subPath": "workspace", "mountPath": "/sandbox/enterprise", "readOnly": false},
			},
			"policy": map[string]any{
				"process": map[string]string{"runAsUser": "1000", "runAsGroup": "1000"},
				"networkPolicies": []any{
					map[string]any{"name": "source-control", "endpoints": []any{map[string]any{"host": "github.com", "ports": []int{443}, "tls": "skip"}}, "binaries": []any{map[string]string{"path": "/usr/bin/git"}}},
					map[string]any{"name": "model-provider", "endpoints": []any{map[string]any{"host": "api.openai.com", "ports": []int{443}, "tls": "skip"}}, "binaries": []any{map[string]string{"path": "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.156.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex"}}},
				},
			},
			"sandboxNamePrefix": "os",
		},
	}
}
