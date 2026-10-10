package occdev

import (
	"context"
	"crypto/rand"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"go.yaml.in/yaml/v3"
)

// Up provisions the disposable Kubernetes development stack.
func Up(ctx context.Context, opts Options) (result error) {
	if err := checkKubernetesPlatform(); err != nil {
		return err
	}
	r := newRunner(opts)
	sandboxDriver := r.setting("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
	if sandboxDriver != "none" && sandboxDriver != "openshell" {
		return fmt.Errorf("OCC_DEVELOPMENT_SANDBOX_DRIVER must be none or openshell")
	}
	controlPlane := r.setting("OCC_DEVELOPMENT_CONTROL_PLANE", "compose")
	if controlPlane != "compose" && controlPlane != "kubernetes" {
		return fmt.Errorf("OCC_DEVELOPMENT_CONTROL_PLANE must be compose or kubernetes")
	}
	if controlPlane == "kubernetes" {
		return upK3d(ctx, opts, sandboxDriver)
	}
	timeout, err := positiveSetting(r, "OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS", 300, 86400)
	if err != nil {
		return err
	}
	port, err := positiveSetting(r, "OCC_DEVELOPMENT_KUBERNETES_API_PORT", 6443, 65535)
	if err != nil {
		return err
	}
	threshold, err := positiveSetting(r, "OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT", 5, 20)
	if err != nil {
		return err
	}
	directory, err := stateDirectory(r.env["OCC_DEVELOPMENT_STATE_DIRECTORY"], opts.Repository, false)
	if err != nil {
		return err
	}
	state := &developmentState{Repository: opts.Repository, Version: 3, ComputeDriver: "kubernetes", SandboxDriver: sandboxDriver, ComposeProject: r.setting("OCC_DEVELOPMENT_COMPOSE_PROJECT", "openclaw-enterprise-development-kubernetes"), Cluster: r.setting("OCC_DEVELOPMENT_KUBERNETES_CLUSTER", "occ-dev-"+strings.ToLower(rand.Text()[:10])), directory: directory, KeyPath: opts.KeyOutput, KeyOwned: opts.KeyOutput == ""}

	if err := validateClusterName(state.Cluster); err != nil {
		return err
	}
	if !projectName.MatchString(state.ComposeProject) {
		return fmt.Errorf("invalid OCC_DEVELOPMENT_COMPOSE_PROJECT %q: the name must match %s", state.ComposeProject, projectName)
	}
	if state.KeyOwned {
		state.KeyPath = filepath.Join(directory, "initial-admin-service-key.json")
	} else if err := validateKeyOutput(state.KeyPath); err != nil {
		return err
	}
	if err := validateComposeArgs(opts.ComposeArgs, opts.Repository); err != nil {
		return err
	}
	required := []string{"k3d", "kubectl"}
	if sandboxDriver == "none" {
		required = append(required, "node")
	} else {
		required = append(required, "helm")
	}
	for _, name := range required {
		if _, err := exec.LookPath(name); err != nil {
			return fmt.Errorf("%s is required on PATH", name)
		}
	}
	if err := r.selectEngine(ctx, r.setting("OCC_DEVELOPMENT_CONTAINER_ENGINE", "auto")); err != nil {
		return err
	}
	if err := r.pinEndpoint(ctx); err != nil {
		return err
	}
	if err := r.checkLegacyNATTable(ctx); err != nil {
		return err
	}
	state.ContainerEngine = r.engine
	state.DockerHost = r.env["DOCKER_HOST"]
	if err := r.ensureAbsent(ctx, state); err != nil {
		return err
	}
	r.env["KUBECONFIG"] = filepath.Join(directory, "kubeconfig")
	r.env["OCC_DEVELOPMENT_INSTALLATION_CONFIG"] = filepath.Join(directory, "installation.yaml")
	r.env["OCC_DEVELOPMENT_KUBECONFIG"] = filepath.Join(directory, "container-kubeconfig")
	r.env["OCC_DEVELOPMENT_NETWORK_NAME"] = state.ComposeProject + "_development"
	args := []string{"compose", "--project-name", state.ComposeProject, "-f", "compose.yaml", "-f", "compose.kubernetes.yaml"}
	args = append(args, opts.ComposeArgs...)
	args = append(args, "config")
	config, err := r.output(ctx, r.engine, args...)
	if err != nil {
		return err
	}
	var rendered any
	if err := yaml.Unmarshal(config, &rendered); err != nil {
		return fmt.Errorf("invalid rendered Compose configuration: %w", err)
	}
	if err := setKubernetesBridgeGateway(rendered); err != nil {
		return err
	}
	if sandboxDriver == "openshell" {
		if err := addComposeGatewayRouting(rendered, state); err != nil {
			return err
		}
	}
	if err := r.validateResourceOwnership(ctx, rendered, state); err != nil {
		return err
	}
	data, err := json.Marshal(rendered)
	if err != nil {
		return err
	}
	analysis, err := AnalyzeCompose(data, "kubernetes")
	if err != nil {
		return err
	}
	if len(analysis) == 0 {
		return fmt.Errorf("Compose analysis returned no API URL")
	}
	apiURL := analysis[0]
	snapshot, err := yaml.Marshal(escapeInterpolation(rendered))
	if err != nil {
		return err
	}
	// The exclusive directory claim is the ownership boundary, including concurrent starts.
	if err := os.Mkdir(directory, 0700); err != nil {
		return err
	}
	lock, err := lockState(directory)
	if err != nil {
		return err
	}
	started, clusterAttempted, clusterCreationFailed, keyWritten := false, false, false, false
	defer func() {
		defer lock.Close()
		if result == nil {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		var cleanupErr error
		if started {
			cleanupErr = r.cleanup(cleanupCtx, state, clusterAttempted)
		}
		if clusterCreationFailed {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("cluster creation failed; verify and retry recorded cleanup"))
		}
		if cleanupErr == nil {
			cleanupErr = os.RemoveAll(directory)
		}
		if keyWritten && !state.KeyOwned {
			if err := os.Remove(state.KeyPath); err != nil && !os.IsNotExist(err) {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("remove copied service key: %w", err))
			}
		}
		if cleanupErr != nil {
			result = errors.Join(result, fmt.Errorf("rollback incomplete; preserving %s for occ dev down: %w", directory, cleanupErr))
		}
	}()
	if err := exclusiveWrite(filepath.Join(directory, ".openclaw-development"), []byte(stateMarker), 0600); err != nil {
		return err
	}
	stateData, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := exclusiveWrite(filepath.Join(directory, "state.json"), stateData, 0600); err != nil {
		return err
	}
	if err := exclusiveWrite(filepath.Join(directory, "compose.yaml"), snapshot, 0600); err != nil {
		return err
	}
	fmt.Fprintln(r.opts.Out, "Starting the Compose database, migration, and bootstrap services...")
	started = true
	if err := r.compose(ctx, state, "up", "--build", "-d", "postgres", "migrate", "bootstrap"); err != nil {
		return err
	}
	for _, service := range []string{"migrate", "bootstrap"} {
		if err := r.waitCompleted(ctx, state, service, time.Duration(timeout)*time.Second); err != nil {
			return err
		}
	}
	fmt.Fprintf(r.opts.Out, "Creating k3d cluster %s...\n", state.Cluster)
	clusterAttempted = true
	clusterImage := r.setting("OCC_DEVELOPMENT_K3S_IMAGE", "+v1.35")
	if sandboxDriver == "openshell" {
		clusterImage = openShellK3sImage
	}
	clusterArgs := []string{"cluster", "create", state.Cluster, "--timeout", (time.Duration(timeout) * time.Second).String(), "--env", "IPTABLES_MODE=legacy@server:0"}
	resolverArgs, err := r.prepareDevelopmentResolver(ctx, state, clusterImage)
	if err != nil {
		return err
	}
	clusterArgs = append(clusterArgs, resolverArgs...)
	if sandboxDriver == "openshell" {
		admissionPath, err := prepareOpenShellAdmission(directory)
		if err != nil {
			return err
		}
		clusterArgs = append(clusterArgs, "--volume", admissionPath+":"+openShellAdmissionContainerPath+":ro@server:0", "--k3s-arg", "--kube-apiserver-arg=admission-control-config-file="+openShellAdmissionContainerPath+"@server:0")
	}
	clusterArgs = append(clusterArgs, "--image", clusterImage, "--servers", "1", "--agents", "0", "--network", state.ComposeProject+"_development", "--api-port", fmt.Sprintf("127.0.0.1:%d", port), "--k3s-arg", "--tls-san=k3d-"+state.Cluster+"-serverlb@server:*", "--k3s-arg", fmt.Sprintf("--kubelet-arg=eviction-hard=memory.available<100Mi,nodefs.available<%d%%,nodefs.inodesFree<5%%,imagefs.available<%d%%,imagefs.inodesFree<5%%@server:*", threshold, threshold), "--kubeconfig-update-default=false", "--kubeconfig-switch-context=false")
	if err := r.createK3dCluster(ctx, clusterArgs...); err != nil {
		clusterCreationFailed = true
		return err
	}
	if err := r.checkDevelopmentNodeDNS(ctx, state); err != nil {
		return err
	}
	if err := r.writeKubeconfigs(ctx, state); err != nil {
		return err
	}
	var openShellAssets *openShellDevelopmentAssets
	if sandboxDriver == "openshell" {
		fmt.Fprintln(r.opts.Out, "Preparing pinned OpenShell development assets...")
		openShellAssets, err = r.prepareOpenShell(ctx, state, time.Duration(timeout)*time.Second)
		if err != nil {
			return err
		}
	}
	reference, err := r.importRuntime(ctx, state)
	if err != nil {
		return err
	}
	if sandboxDriver == "openshell" {
		fmt.Fprintf(r.opts.Out, "Installing the deployment OpenShell gateway in Namespace %s...\n", openShellGatewayNamespace)
		if err := r.installOpenShellGateway(ctx, state, openShellAssets, openShellGatewayNamespace, time.Duration(timeout)*time.Second); err != nil {
			return err
		}
	}
	var routing *composeDevelopmentRouting
	if sandboxDriver == "openshell" {
		fmt.Fprintln(r.opts.Out, "Installing pinned private routing for the Compose control plane...")
		routing, err = r.prepareComposeDevelopmentRouting(ctx, state, reference, apiURL, time.Duration(timeout)*time.Second)
		if err != nil {
			return err
		}
	}
	var codexSeccompProfile string
	if sandboxDriver == "none" {
		codexSeccompProfile, err = r.prepareDevelopmentCodexSandbox(ctx, state, reference, timeout)
		if err != nil {
			return err
		}
	}
	statusProxySource, err := r.developmentStatusProxySource(ctx, state)
	if err != nil {
		return err
	}
	openShellGatewayAddress := ""
	if sandboxDriver == "openshell" {
		openShellGatewayAddress, err = r.openShellGatewayAddress(ctx, openShellGatewayNamespace)
		if err != nil {
			return err
		}
	}
	if err := writeInstallation(state, reference, openShellAssets, openShellGatewayAddress, codexSeccompProfile, statusProxySource); err != nil {
		return err
	}
	if routing != nil {
		if err := configureDevelopmentRouting(state, routing.trustedProxyCIDRs, routing.endpoint); err != nil {
			return err
		}
	}
	fmt.Fprintln(r.opts.Out, "Starting the Compose controller and Kubernetes worker...")
	if err := r.compose(ctx, state, "up", "--build", "-d", "controller", "worker-kubernetes"); err != nil {
		return err
	}
	if routing != nil {
		if err := r.finalizeComposeDevelopmentRouting(ctx, state, routing, time.Duration(timeout)*time.Second); err != nil {
			return err
		}
	}
	if err := r.waitReady(ctx, state, apiURL, time.Duration(timeout)*time.Second); err != nil {
		return err
	}
	installation, client, err := r.copyAndVerifyKey(ctx, state, apiURL)
	if err != nil {
		return err
	}
	keyWritten = true
	if sandboxDriver == "openshell" {
		_, namespaceID, err := r.waitForDevelopmentKubernetesNamespace(ctx, time.Duration(timeout)*time.Second)
		if err != nil {
			return err
		}
		if err := waitForDevelopmentNamespace(ctx, client, namespaceID, time.Duration(timeout)*time.Second); err != nil {
			return err
		}
	}
	cleanupSandbox := ""
	if sandboxDriver == "openshell" {
		cleanupSandbox = " OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell"
	}
	fmt.Fprintf(r.opts.Out, "OpenClaw Enterprise development stack is ready.\nContainer engine: %s\nControl plane: Compose\nCompute Driver: Kubernetes\nSandbox Driver: %s\nAPI URL: %s\nInstallation ID: %s\nService key file: %s\nKubeconfig: %s\nKubernetes context: k3d-%s\n\nCleanup:\n  env OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes%s OCC_DEVELOPMENT_STATE_DIRECTORY=%s %s dev down\n", r.engine, sandboxDriver, apiURL, installation, state.KeyPath, filepath.Join(directory, "kubeconfig"), state.Cluster, cleanupSandbox, shellQuote(directory), shellQuote(filepath.Join(opts.Repository, "bin", "occ")))
	return nil
}
func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
func positiveSetting(r *runner, key string, fallback, max int) (int, error) {
	n, err := strconv.Atoi(r.setting(key, strconv.Itoa(fallback)))
	if err != nil || n < 1 || n > max {
		return 0, fmt.Errorf("%s must be between 1 and %d", key, max)
	}
	return n, nil
}
func validateComposeArgs(args []string, repository string) error {
	for i := 0; i < len(args); i++ {
		flag, value, inline := strings.Cut(args[i], "=")
		switch flag {
		case "-f", "--file", "--env-file", "--project-directory":
		default:
			return fmt.Errorf("unsupported Kubernetes Compose option: %s", flag)
		}
		if !inline {
			i++
			if i == len(args) {
				return fmt.Errorf("%s requires a path", flag)
			}
			value = args[i]
		}
		if value == "" || value == "-" {
			return fmt.Errorf("%s requires a file path", flag)
		}
		if flag == "--project-directory" {
			if !filepath.IsAbs(value) {
				value = filepath.Join(repository, value)
			}
			if filepath.Clean(value) != filepath.Clean(repository) {
				return fmt.Errorf("Compose project directory must be the repository")
			}
		}
	}
	return nil
}
func (r *runner) validateResourceOwnership(ctx context.Context, rendered any, s *developmentState) error {
	config, ok := rendered.(map[string]any)
	if !ok {
		return fmt.Errorf("invalid Compose configuration")
	}
	for _, kind := range []string{"volume", "network"} {
		resources, _ := config[kind+"s"].(map[string]any)
		for key, item := range resources {
			resource, _ := item.(map[string]any)
			if external, exists := resource["external"]; exists && external != false {
				return fmt.Errorf("Kubernetes development cannot use external %ss", kind)
			}
			name, _ := resource["name"].(string)
			if name == "" {
				name = s.ComposeProject + "_" + key
			}
			if name != s.ComposeProject+"_"+key {
				return fmt.Errorf("Compose %s %s must use project-owned name %s_%s", kind, key, s.ComposeProject, key)
			}
			if _, err := r.output(ctx, r.engine, kind, "inspect", name); err == nil {
				return fmt.Errorf("Compose resource already exists: %s", name)
			}
		}
	}
	services, _ := config["services"].(map[string]any)
	for name, item := range services {
		service, _ := item.(map[string]any)
		if _, exists := service["container_name"]; exists {
			return fmt.Errorf("service %s must use a Compose-owned container name", name)
		}
	}
	return nil
}

func escapeInterpolation(value any) any {
	switch v := value.(type) {
	case string:
		return strings.ReplaceAll(v, "$", "$$")
	case []any:
		for i, item := range v {
			v[i] = escapeInterpolation(item)
		}
	case map[string]any:
		for key, item := range v {
			v[key] = escapeInterpolation(item)
		}
	}
	return value
}
func (r *runner) ensureAbsent(ctx context.Context, s *developmentState) error {
	exists, err := r.clusterExists(ctx, s.Cluster)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("k3d cluster already exists: %s", s.Cluster)
	}
	for _, prefix := range []string{"com.docker.compose", "io.podman.compose"} {
		for _, args := range [][]string{{"ps", "--all", "--quiet"}, {"volume", "ls", "--quiet"}, {"network", "ls", "--quiet"}} {
			data, err := r.output(ctx, r.engine, append(args, "--filter", "label="+prefix+".project="+s.ComposeProject)...)
			if err != nil {
				return err
			}
			if len(data) > 0 {
				return fmt.Errorf("Compose project already has resources: %s", s.ComposeProject)
			}
		}
	}
	// Unlabelled resources with the names Compose would adopt also belong to someone else.
	for _, resource := range []struct{ kind, name string }{{"volume", "occ_postgres_data"}, {"volume", "occ_bootstrap_data"}, {"volume", "occ_configuration_data"}, {"network", "development"}} {
		if _, err := r.output(ctx, r.engine, resource.kind, "inspect", s.ComposeProject+"_"+resource.name); err == nil {
			return fmt.Errorf("Compose resource already exists: %s_%s", s.ComposeProject, resource.name)
		}
	}
	return nil
}
func (r *runner) waitCompleted(ctx context.Context, s *developmentState, service string, timeout time.Duration) error {
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		id, err := r.composeOutput(ctx, s, "ps", "--all", "-q", service)
		if err != nil {
			return false, err
		}
		if len(id) == 0 {
			return false, nil
		}
		if strings.ContainsAny(string(id), "\n\r") {
			return false, fmt.Errorf("multiple containers found for %s", service)
		}
		status, err := r.output(ctx, r.engine, "inspect", "--format", "{{.State.Status}}", string(id))
		if err != nil {
			return false, err
		}
		if string(status) != "exited" && string(status) != "dead" {
			return false, nil
		}
		code, err := r.output(ctx, r.engine, "inspect", "--format", "{{.State.ExitCode}}", string(id))
		if err != nil {
			return false, err
		}
		if string(status) == "exited" && string(code) == "0" {
			return true, nil
		}
		return false, fmt.Errorf("%s exited with %s", service, code)
	})
}
func poll(ctx context.Context, timeout time.Duration, check func(context.Context) (bool, error)) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		ready, err := check(ctx)
		if err != nil {
			return err
		}
		if ready {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("development readiness: %w", ctx.Err())
		case <-time.After(time.Second):
		}
	}
}
func (r *runner) waitReady(ctx context.Context, s *developmentState, url string, timeout time.Duration) error {
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/api/auth/session", nil)
		if err != nil {
			return false, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return false, nil
		}
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return false, nil
		}
		_, err = r.composeOutput(ctx, s, "exec", "-T", "worker-kubernetes", "node", "scripts/production-healthcheck.mjs", "worker", "ready")
		return err == nil, nil
	})
}
func (r *runner) copyAndVerifyKey(ctx context.Context, s *developmentState, url string) (string, *occclient.Client, error) {
	id, err := r.composeOutput(ctx, s, "ps", "--all", "-q", "bootstrap")
	if err != nil {
		return "", nil, err
	}
	if len(id) == 0 || strings.ContainsAny(string(id), "\r\n") {
		return "", nil, fmt.Errorf("could not identify bootstrap container")
	}
	temporary := filepath.Join(s.directory, "bootstrap-key-copy.json")
	if err := r.run(ctx, r.engine, "cp", string(id)+":/var/lib/openclaw/bootstrap/initial-admin-service-key.json", temporary); err != nil {
		return "", nil, err
	}
	if err := os.Chmod(temporary, 0600); err != nil {
		return "", nil, err
	}
	data, err := os.ReadFile(temporary)
	if err != nil {
		return "", nil, err
	}
	var key struct {
		Meta struct {
			InstallationID string `json:"installationId"`
		} `json:"meta"`
		Data struct {
			Key string `json:"key"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &key); err != nil || key.Meta.InstallationID == "" || strings.TrimSpace(key.Data.Key) == "" {
		return "", nil, fmt.Errorf("bootstrap service key is missing its key or Installation ID")
	}
	client, err := occclient.New(occclient.Config{URL: url, ServiceKeyFile: temporary, Timeout: 15 * time.Second, Context: ctx})
	if err != nil {
		return "", nil, err
	}
	installation, err := client.GetInstallation()
	if err != nil {
		return "", nil, fmt.Errorf("Installation authorization failed: %w", err)
	}
	record, ok := installation.(map[string]any)
	if !ok || record["id"] != key.Meta.InstallationID {
		return "", nil, fmt.Errorf("Installation ID does not match the bootstrap service key")
	}
	if err := exclusiveWrite(s.KeyPath, data, 0600); err != nil {
		return "", nil, err
	}
	if err := os.Remove(temporary); err != nil {
		return "", nil, err
	}
	return key.Meta.InstallationID, client, nil
}

func waitForDevelopmentNamespace(ctx context.Context, client *occclient.Client, namespaceID string, timeout time.Duration) error {
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		value, err := client.WithContext(ctx).GetNamespace(namespaceID)
		if err != nil {
			return false, nil
		}
		namespace, ok := value.(map[string]any)
		if !ok || namespace["id"] != namespaceID {
			return false, fmt.Errorf("OCC returned an invalid bootstrap Namespace")
		}
		status, _ := namespace["status"].(string)
		if status == "failed" || status == "deleting" {
			return false, fmt.Errorf("bootstrap Namespace entered status %s", status)
		}
		return status == "ready", nil
	})
}
