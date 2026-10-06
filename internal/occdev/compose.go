package occdev

import (
	"encoding/json/v2"
	"fmt"
	"net"
	"net/netip"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	developmentGatewayAPIKeyMount = "/run/openclaw-development/gateway-api-key"
	developmentGatewayCAMount     = "/run/openclaw-development/gateway-ca.crt"
)

// k3d needs an explicit gateway when joining a Compose-owned Docker network.
// Resolve it from the rendered subnet so Compose overrides keep their meaning.
func setKubernetesBridgeGateway(rendered any) error {
	config, _ := rendered.(map[string]any)
	networks, _ := config["networks"].(map[string]any)
	development, _ := networks["development"].(map[string]any)
	ipam, _ := development["ipam"].(map[string]any)
	entries, _ := ipam["config"].([]any)
	if len(entries) == 0 {
		return fmt.Errorf("Kubernetes development requires a Compose development network subnet")
	}
	for _, raw := range entries {
		entry, _ := raw.(map[string]any)
		if gateway, _ := entry["gateway"].(string); gateway != "" {
			continue
		}
		subnet, _ := entry["subnet"].(string)
		prefix, err := netip.ParsePrefix(subnet)
		if err != nil || prefix.Bits() >= prefix.Addr().BitLen()-1 {
			return fmt.Errorf("Compose development subnet must have space for a bridge gateway and containers")
		}
		entry["gateway"] = prefix.Masked().Addr().Next().String()
	}
	return nil
}

// addComposeGatewayRouting projects only the private routing key and public CA
// into the two trusted control-plane services. The Kubernetes workloads never
// receive the Installation-wide service key.
func addComposeGatewayRouting(rendered any, state *developmentState) error {
	config, _ := rendered.(map[string]any)
	services, _ := config["services"].(map[string]any)
	for _, name := range []string{"controller", "worker-kubernetes"} {
		service, _ := services[name].(map[string]any)
		if service == nil {
			return fmt.Errorf("Compose configuration does not define the %s service", name)
		}
		environment, _ := service["environment"].(map[string]any)
		if environment == nil {
			return fmt.Errorf("Compose %s service has no environment configuration", name)
		}
		for key, value := range map[string]string{
			"OCC_GATEWAY_API_KEY_PATH": developmentGatewayAPIKeyMount,
			"NODE_EXTRA_CA_CERTS":      developmentGatewayCAMount,
		} {
			if existing, found := environment[key]; found && composeValue(existing) != value {
				return fmt.Errorf("Compose %s must not override %s", name, key)
			}
			environment[key] = value
		}
		volumes, _ := service["volumes"].([]any)
		for _, volume := range []struct{ source, target string }{
			{filepath.Join(state.directory, "gateway-api-key"), developmentGatewayAPIKeyMount},
			{filepath.Join(state.directory, "gateway-ca.crt"), developmentGatewayCAMount},
		} {
			for _, raw := range volumes {
				existing, _ := raw.(map[string]any)
				if composeValue(existing["target"]) == volume.target {
					return fmt.Errorf("Compose %s already mounts %s", name, volume.target)
				}
			}
			volumes = append(volumes, map[string]any{
				"type": "bind", "source": volume.source, "target": volume.target,
				"read_only": true, "bind": map[string]any{"selinux": "z"},
			})
		}
		service["volumes"] = volumes
	}
	return nil
}

type composeService struct {
	Ports       []any          `json:"ports"`
	Environment map[string]any `json:"environment"`
	NetworkMode string         `json:"network_mode"`
}

var shortPublication = regexp.MustCompile(`^(?:\[([^]]+)\]|([^:]+)):(\d+):(\d+)(?:/(tcp|udp))?$`)

// AnalyzeCompose validates the rendered development publications and returns
// the API URL, followed by Docker runtime selection when that profile is used.
func AnalyzeCompose(data []byte, profile string) ([]string, error) {
	if profile != "docker" && profile != "kubernetes" {
		return nil, fmt.Errorf("development profile must be docker or kubernetes")
	}
	var config struct {
		Services map[string]*composeService `json:"services"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("could not read resolved Compose configuration: %w", err)
	}
	for _, name := range []string{"controller", "postgres"} {
		if config.Services[name] == nil {
			return nil, fmt.Errorf("Compose configuration does not define the %s service", name)
		}
		if config.Services[name].NetworkMode != "" {
			return nil, fmt.Errorf("Compose %s must use the development network, not network_mode", name)
		}
	}
	apiURL := ""
	for _, service := range []struct{ name, label string }{{"postgres", "PostgreSQL"}, {"controller", "controller"}} {
		for _, raw := range config.Services[service.name].Ports {
			host, published, target, protocol, err := parsePublication(raw)
			if err != nil {
				return nil, err
			}
			if host != "127.0.0.1" && host != "::1" {
				return nil, fmt.Errorf("Compose %s port must publish only on loopback", service.label)
			}
			port, err := strconv.Atoi(published)
			if err != nil || port < 1 || port > 65535 || strconv.Itoa(port) != published {
				return nil, fmt.Errorf("Compose %s port must select an explicit host port", service.label)
			}
			if service.name == "controller" && target == "3000" && protocol == "tcp" && apiURL == "" {
				apiURL = "http://" + net.JoinHostPort(host, published)
			}
		}
	}
	if apiURL == "" {
		return nil, fmt.Errorf("Compose controller service must publish container port 3000 on loopback")
	}
	result := []string{apiURL}
	if profile == "kubernetes" {
		if config.Services["worker-kubernetes"] == nil {
			return nil, fmt.Errorf("Compose configuration does not define the worker-kubernetes service")
		}
		return result, nil
	}
	worker := config.Services["worker"]
	if worker == nil {
		return nil, fmt.Errorf("Compose configuration does not define the worker service")
	}
	shared := composeValue(worker.Environment["OCC_DOCKER_RUNTIME_IMAGE"])
	gateway := composeValue(worker.Environment["OCC_DOCKER_GATEWAY_IMAGE"])
	agent := composeValue(worker.Environment["OCC_DOCKER_AGENT_IMAGE"])
	if gateway == "" {
		gateway = shared
	}
	if agent == "" {
		agent = shared
	}
	if gateway == "" && agent == "" {
		return append(result, "default"), nil
	}
	if gateway == "" {
		return nil, fmt.Errorf("Docker gateway image must be explicitly configured")
	}
	if agent == "" {
		return nil, fmt.Errorf("Docker Codex Agent image must be explicitly configured")
	}
	for _, image := range []string{gateway, agent} {
		if strings.ContainsAny(image, "\r\n\t ") {
			return nil, fmt.Errorf("Docker runtime image must not contain whitespace")
		}
	}
	result = append(result, "custom", gateway)
	if agent != gateway {
		result = append(result, agent)
	}
	return result, nil
}

func composeValue(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func parsePublication(raw any) (host, published, target, protocol string, err error) {
	switch port := raw.(type) {
	case map[string]any:
		host, published, target = composeValue(port["host_ip"]), composeValue(port["published"]), composeValue(port["target"])
		protocol = composeValue(port["protocol"])
	case string:
		parts := shortPublication.FindStringSubmatch(port)
		if parts == nil {
			return "", "", "", "", fmt.Errorf("Compose port publication must include an explicit host IP")
		}
		host = parts[1] + parts[2]
		published, target, protocol = parts[3], parts[4], parts[5]
	default:
		return "", "", "", "", fmt.Errorf("Compose ports must be resolved objects or host publications")
	}
	if protocol == "" {
		protocol = "tcp"
	}
	return
}
