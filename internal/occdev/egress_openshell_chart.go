package occdev

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"go.yaml.in/yaml/v3"
)

// Helm accepts unknown values. Check the gateway's effective registration and
// public trust wiring before creating a cluster; Compute still admits the live capability.
func (r *runner) checkProtectedOpenShellChart(ctx context.Context, state *developmentState, images openShellImageSelection) error {
	const selector = "OCC_DEVELOPMENT_OPENSHELL_HELM_CHART"
	chart := r.env[selector]
	if !filepath.IsAbs(chart) || filepath.Clean(chart) != chart {
		return fmt.Errorf("protected egress requires %s to be an absolute canonical chart path", selector)
	}
	assets := &openShellDevelopmentAssets{gatewayChart: chart, gatewayImage: images.gateway, sandboxImage: images.sandbox, supervisorImage: images.supervisor}
	rendered, err := r.renderOpenShellGatewayChart(ctx, state, assets, developmentProtectedOpenShellValues(state))
	if err != nil {
		return fmt.Errorf("cannot render protected OpenShell Gateway chart %s: %w", chart, err)
	}
	if err := verifyProtectedOpenShellChart(rendered, state); err != nil {
		// Rendered manifests can include generated Secrets. Report only the failed contract.
		return fmt.Errorf("protected egress: %w; set %s to a Gateway chart that implements secure supervisor.middleware", err, selector)
	}
	return nil
}

// renderOpenShellGatewayChart renders the Gateway release offline with the
// launcher's own arguments and one complete values document on stdin.
func (r *runner) renderOpenShellGatewayChart(ctx context.Context, state *developmentState, assets *openShellDevelopmentAssets, values map[string]any) ([]byte, error) {
	data, err := json.Marshal(values)
	if err != nil {
		return nil, err
	}
	// Only the offline render skips the chart's live Agent Sandbox API discovery.
	// Image imports can change the local repository names, not the middleware values.
	args := []string{"template", openShellGatewayService, assets.gatewayChart, "--namespace", state.PlatformNamespace, "--set=agentSandbox.preflight.enabled=false"}
	cmd := r.command(ctx, "helm", append(args, openShellGatewayValues(state, assets, "-")...)...)
	cmd.Stdin = bytes.NewReader(data)
	return cmd.Output()
}

// gatewayMiddleware is one supervisor middleware registration a profile requires.
type gatewayMiddleware struct {
	name, endpoint, audience, timeout, caConfigMap string
	payload                                        int
}

func protectedGatewayMiddleware(state *developmentState) gatewayMiddleware {
	return gatewayMiddleware{name: developmentEgressMiddleware, endpoint: developmentAuthorityEndpoint(state), audience: developmentEgressAudience,
		timeout: developmentEgressTimeout, caConfigMap: developmentEgressCA, payload: developmentEgressPayload}
}

func verifyProtectedOpenShellChart(rendered []byte, state *developmentState) error {
	return verifyOpenShellGatewayChart(rendered, state, []gatewayMiddleware{protectedGatewayMiddleware(state)})
}

// verifyOpenShellGatewayChart requires the rendered gateway.toml to register
// exactly the profile's middleware, each over secure transport with its public
// CA mounted read-only in the Gateway container. A profile never inherits
// another profile's registration: protected egress and OpenShell Git are
// mutually exclusive (the OCE chart refuses openshellGit with egressAuthority).
func verifyOpenShellGatewayChart(rendered []byte, state *developmentState, want []gatewayMiddleware) error {
	const configMap = openShellGatewayService + "-config"
	var config string
	var pod protectedGatewayPod
	dec := yaml.NewDecoder(bytes.NewReader(rendered))
	for {
		var doc struct {
			Kind     string
			Metadata struct{ Name, Namespace string }
			Data     map[string]string
			Spec     struct {
				Template struct{ Spec protectedGatewayPod }
			}
		}
		if err := dec.Decode(&doc); err == io.EOF {
			break
		} else if err != nil {
			return fmt.Errorf("Helm did not render valid Gateway manifests")
		}
		if ns := doc.Metadata.Namespace; ns != "" && ns != state.PlatformNamespace {
			continue
		}
		switch {
		case doc.Kind == "ConfigMap" && doc.Metadata.Name == configMap:
			config = doc.Data["gateway.toml"]
		case doc.Kind == "StatefulSet" && doc.Metadata.Name == openShellGatewayService:
			pod = doc.Spec.Template.Spec
		}
	}
	var gateway struct {
		Openshell struct {
			Supervisor struct {
				Middleware []struct {
					Name, Audience, Timeout string
					Endpoint                string `toml:"grpc_endpoint"`
					Payload                 int    `toml:"max_payload_bytes"`
					Insecure                *bool  `toml:"allow_insecure_transport"`
					CAPath                  string `toml:"tls_ca_cert_path"`
				}
			}
		}
	}
	if err := toml.Unmarshal([]byte(config), &gateway); err != nil {
		return fmt.Errorf("rendered gateway.toml is not valid TOML")
	}
	registry := gateway.Openshell.Supervisor.Middleware
	names := make([]string, len(want))
	for i, w := range want {
		names[i] = w.name
	}
	matches := len(registry) == len(want)
	for i := 0; matches && i < len(want); i++ {
		matches = registry[i].Name == want[i].name
	}
	if !matches {
		if len(want) == 1 {
			return fmt.Errorf("rendered gateway.toml must register exactly one supervisor middleware, %s", want[0].name)
		}
		return fmt.Errorf("rendered gateway.toml must register exactly the supervisor middleware %s", strings.Join(names, ", "))
	}
	for i, w := range want {
		m := registry[i]
		// The stock Gateway defaults allow_insecure_transport to false; a launcher
		// registration still states it so the render proves the selected value.
		if m.Endpoint != w.endpoint || m.Audience != w.audience ||
			m.Insecure == nil || *m.Insecure || m.Payload != w.payload || m.Timeout != w.timeout {
			return fmt.Errorf("rendered %s registration does not select the required HTTPS endpoint, audience, secure transport and request limits", m.Name)
		}
	}
	for _, c := range pod.Containers {
		if c.Name != openShellGatewayService {
			continue
		}
		i := slices.Index(c.Args, "--config")
		configPath := pod.mountedConfigMapKey(c.Mounts, configMap, "gateway.toml")
		if !path.IsAbs(configPath) || i < 0 || i+1 >= len(c.Args) || c.Args[i+1] != configPath {
			return fmt.Errorf("rendered Gateway must load gateway.toml from ConfigMap %s", configMap)
		}
		for i, w := range want {
			caPath := pod.mountedConfigMapKey(c.Mounts, w.caConfigMap, "ca.crt")
			if !path.IsAbs(caPath) || caPath != registry[i].CAPath {
				return fmt.Errorf("rendered Gateway must mount public ConfigMap %s key ca.crt read-only at the registration's tls_ca_cert_path", w.caConfigMap)
			}
		}
		return nil
	}
	return fmt.Errorf("rendered chart is missing the %s StatefulSet and Gateway container", openShellGatewayService)
}

// The launcher waits for this StatefulSet. Resolve both ConfigMap keys through
// its actual gateway container, not another resource, a sidecar, or a Secret.
type protectedGatewayPod struct {
	Volumes []struct {
		Name      string
		ConfigMap struct {
			Name     string
			Optional bool
			Items    []struct{ Key, Path string }
		} `yaml:"configMap"`
	}
	Containers []struct {
		Name   string
		Args   []string
		Mounts []protectedGatewayMount `yaml:"volumeMounts"`
	}
}

type protectedGatewayMount struct {
	Name     string
	Path     string `yaml:"mountPath"`
	SubPath  string `yaml:"subPath"`
	ReadOnly bool   `yaml:"readOnly"`
}

func (pod protectedGatewayPod) mountedConfigMapKey(mounts []protectedGatewayMount, name, key string) string {
	for _, volume := range pod.Volumes {
		cm := volume.ConfigMap
		if cm.Name != name || cm.Optional {
			continue
		}
		file := key
		if len(cm.Items) > 0 {
			i := slices.IndexFunc(cm.Items, func(item struct{ Key, Path string }) bool { return item.Key == key })
			if i < 0 {
				continue
			}
			file = cm.Items[i].Path
		}
		for _, m := range mounts {
			if m.Name != volume.Name || !m.ReadOnly {
				continue
			}
			switch m.SubPath {
			case "":
				return path.Join(m.Path, file)
			case file:
				return m.Path
			}
		}
	}
	return ""
}
