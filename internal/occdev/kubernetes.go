package occdev

import (
	"context"
	"encoding/json/v2"
	"fmt"
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
	if _, err := r.output(ctx, r.engine, "image", "inspect", image); err != nil {
		if r.env["OCC_KUBERNETES_RUNTIME_IMAGE"] != "" {
			return "", fmt.Errorf("explicitly selected runtime image must already exist locally: %s", image)
		}
		if err := r.run(ctx, r.engine, "build", "-f", "deploy/runtime/Dockerfile", "--tag", image, "deploy/runtime"); err != nil {
			return "", err
		}
	}
	if err := r.run(ctx, "k3d", "image", "import", image, "-c", s.Cluster); err != nil {
		return "", err
	}
	server := "k3d-" + s.Cluster + "-server-0"
	data, err := r.output(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "list")
	if err != nil {
		return "", err
	}
	normalized := image
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
		if len(fields) >= 3 && (fields[0] == image || fields[0] == normalized) {
			if imported != "" && digest != fields[2] {
				return "", fmt.Errorf("ambiguous imported runtime image")
			}
			imported, digest = fields[0], fields[2]
		}
	}
	if !imageDigest.MatchString(digest) {
		return "", fmt.Errorf("could not resolve imported runtime image digest")
	}
	repository, _, _ := strings.Cut(normalized, "@")
	if index := strings.LastIndex(repository, ":"); index > strings.LastIndex(repository, "/") {
		repository = repository[:index]
	}
	reference := repository + "@" + digest
	if reference != imported {
		if err := r.run(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "tag", imported, reference); err != nil {
			return "", err
		}
	}
	return reference, nil
}
func writeInstallation(s *developmentState, reference string) error {
	auth := map[string]any{"mode": "kubeconfig", "kubeconfigPath": "/run/openclaw-development/kubeconfig", "context": "k3d-" + s.Cluster}
	resources := map[string]any{"requests": map[string]string{"cpu": "100m", "memory": "256Mi"}, "limits": map[string]string{"cpu": "2", "memory": "1Gi"}}
	config := map[string]any{
		"occ": map[string]string{"cluster": s.Cluster}, "provider": []any{},
		"drivers": map[string]any{
			"configuration": map[string]any{"id": "config-kubernetes", "configuration": map[string]any{"authentication": auth}},
			"iam":           map[string]any{"id": "native-iam", "configuration": map[string]any{}},
			"secret":        map[string]any{"id": "secret-kubernetes", "configuration": map[string]any{"authentication": auth}},
			"compute": map[string]any{"id": "compute-kubernetes", "configuration": map[string]any{
				"authentication": auth, "images": map[string]any{"gateway": reference, "agent": reference, "requireImmutableDigest": true},
				"resources":                   map[string]any{"gateway": resources, "agent": resources, "namespace": map[string]any{"quota": map[string]string{"pods": "10"}, "containerDefaults": resources}},
				"network":                     map[string]any{"dns": map[string]any{"namespace": "kube-system", "podLabels": map[string]string{"k8s-app": "kube-dns"}}, "gatewayPort": 8080, "gatewayClients": []any{map[string]any{"namespace": "default", "podLabels": map[string]string{"app.kubernetes.io/name": "occ-kubernetes-dev-client"}}}},
				"servicePrincipalCredentials": map[string]any{"mode": "projectedServiceAccountToken", "audience": "openclaw-enterprise", "expirationSeconds": 900},
				"runtime":                     map[string]string{"gatewayStorageClassName": "local-path", "transportSecretPrefix": "openclaw-agent-transport"},
			}},
		},
	}
	data, err := yaml.Marshal(config)
	if err != nil {
		return err
	}
	return exclusiveWrite(filepath.Join(s.directory, "installation.yaml"), data, 0644)
}
