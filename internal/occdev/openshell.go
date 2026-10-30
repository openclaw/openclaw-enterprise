package occdev

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

const (
	openShellRuntimeClass           = "openshell-sandbox"
	openShellGatewayService         = "openshell-gateway"
	openShellGatewayNamespace       = "openshell-system"
	openShellOperatorNamespaceLabel = "openshell.ai/openclaw-workspace"
	openShellOperatorNamespaceValue = "true"
	openShellManagedByLabel         = "openshell.ai/managed-by"
	openShellManagedByValue         = "openshell"
	openShellBoundaryRoleLabel      = "openshell.ai/boundary-role"
	openShellSupervisorRole         = "supervisor"
	openShellNodePort               = 30051
	openShellK3sImage               = "docker.io/rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657"
	openShellGatewayImage           = "ghcr.io/nvidia/openshell/gateway:0.1.6@sha256:f0b36dba21d282c52e498c25289658cfd6cd4f343b0069fde5609e25b002cdea"
	openShellSandboxImage           = "ghcr.io/nvidia/openshell/sandbox:0.1.6@sha256:1038eb5c1f191fa3c34684fd7041b891c78ec570979d487f36e06e08f91bfb63"
	openShellSupervisorImage        = "ghcr.io/nvidia/openshell/supervisor:0.1.6@sha256:ce859a7d77ee515d3fe0b3c7dc61286516f402eb1d25c761d806d9ae5ed96c0b"
	openShellAdmissionContainerPath = "/etc/openclaw-development/openshell-pod-security-admission.yaml"
	openShellAllowedPodLabelsValue  = `--set-json=gatewayConfig.openshell\.drivers\.kubernetes.allowed_pod_labels=["openclaw.dev/*","app.kubernetes.io/name","app.kubernetes.io/managed-by"]`
)

type openShellDevelopmentAssets struct {
	gatewayChart       string
	workspaceResources []any
	gatewayImage       string
	sandboxImage       string
	supervisorImage    string
}

type openShellImageSelection struct {
	gateway, sandbox, supervisor, revision string
}

// Accept named images (optionally tagged), never bare IDs or mutable tags.
var openShellImageName = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$`)

func (r *runner) selectOpenShellImages(sandboxDriver string) (openShellImageSelection, error) {
	images := openShellImageSelection{gateway: openShellGatewayImage, sandbox: openShellSandboxImage, supervisor: openShellSupervisorImage}
	selectors := []struct {
		key    string
		target *string
	}{
		{"OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE", &images.gateway},
		{"OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE", &images.sandbox},
		{"OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE", &images.supervisor},
		{"OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION", &images.revision},
	}
	selected := false
	complete := true
	for _, selector := range selectors {
		value, supplied := r.env[selector.key]
		selected = selected || supplied
		complete = complete && value != ""
		if supplied {
			*selector.target = value
		}
	}
	if !selected {
		return images, nil
	}
	if sandboxDriver != "openshell" {
		return images, fmt.Errorf("OpenShell candidate images require OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell")
	}
	if !complete {
		return images, fmt.Errorf("OpenShell candidate selection requires all three OCC_DEVELOPMENT_OPENSHELL_{GATEWAY,SANDBOX,SUPERVISOR}_IMAGE values and OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION")
	}
	if len(images.revision) != 40 || strings.Trim(images.revision, "0123456789abcdef") != "" {
		return images, fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION must be a full 40-character lowercase Git commit")
	}
	for _, source := range []string{images.gateway, images.sandbox, images.supervisor} {
		name, digest, found := strings.Cut(source, "@")
		if !found || len(name) > 255 || !openShellImageName.MatchString(name) || !imageDigest.MatchString(digest) {
			return images, fmt.Errorf("OpenShell candidate images must use named immutable sha256 digest references")
		}
	}
	return images, nil
}

func (r *runner) validateOpenShellImageRevisions(ctx context.Context, images openShellImageSelection) error {
	if images.revision == "" {
		return nil
	}
	// Labels establish consistency with the selected OpenShell source, not build provenance.
	for _, source := range []string{images.gateway, images.sandbox, images.supervisor} {
		label, err := r.output(ctx, r.engine, "image", "inspect", "--format", `{{ index .Config.Labels "org.opencontainers.image.revision" }}`, source)
		if err != nil {
			return fmt.Errorf("OpenShell candidate image must exist locally and expose its source revision: %s", source)
		}
		if string(label) != images.revision {
			return fmt.Errorf("OpenShell candidate image revision does not match selected source %s: %s", images.revision, source)
		}
	}
	return nil
}

func openShellAdmissionConfiguration() []byte {
	return []byte(strings.Join([]string{
		"apiVersion: apiserver.config.k8s.io/v1",
		"kind: AdmissionConfiguration",
		"plugins:",
		"  - name: PodSecurity",
		"    configuration:",
		"      apiVersion: pod-security.admission.config.k8s.io/v1",
		"      kind: PodSecurityConfiguration",
		"      defaults:",
		"        enforce: privileged",
		"        enforce-version: latest",
		"        audit: privileged",
		"        audit-version: latest",
		"        warn: privileged",
		"        warn-version: latest",
		"      exemptions:",
		"        usernames: []",
		"        runtimeClasses:",
		"          - " + openShellRuntimeClass,
		"        namespaces: []",
		"",
	}, "\n"))
}

func prepareOpenShellAdmission(directory string) (string, error) {
	path := filepath.Join(directory, "openshell-pod-security-admission.yaml")
	if err := exclusiveWrite(path, openShellAdmissionConfiguration(), 0600); err != nil {
		return "", err
	}
	return path, nil
}

func (r *runner) prepareOpenShell(ctx context.Context, state *developmentState, timeout time.Duration) (*openShellDevelopmentAssets, error) {
	images, err := r.selectOpenShellImages(state.SandboxDriver)
	if err != nil {
		return nil, err
	}
	if err := r.validateOpenShellImageRevisions(ctx, images); err != nil {
		return nil, err
	}
	root := filepath.Join(state.directory, "openshell")
	if err := os.Mkdir(root, 0700); err != nil {
		return nil, err
	}
	gatewayChart, workspaceChart, err := r.openShellCharts(ctx, root)
	if err != nil {
		return nil, err
	}
	manifest, err := r.agentSandboxManifest(ctx, root)
	if err != nil {
		return nil, err
	}
	runtimeClass := filepath.Join(root, "runtime-class.yaml")
	if err := exclusiveWrite(runtimeClass, []byte(strings.Join([]string{
		"apiVersion: node.k8s.io/v1",
		"kind: RuntimeClass",
		"metadata:",
		"  name: " + openShellRuntimeClass,
		"handler: runc",
		"",
	}, "\n")), 0600); err != nil {
		return nil, err
	}
	if err := r.run(ctx, "kubectl", "apply", "-f", runtimeClass); err != nil {
		return nil, err
	}
	if err := r.run(ctx, "kubectl", "apply", "-f", manifest); err != nil {
		return nil, err
	}
	if err := r.run(ctx, "kubectl", "rollout", "status", "deployment/agent-sandbox-controller", "--namespace", "agent-sandbox-system", "--timeout", timeout.String()); err != nil {
		r.captureAgentSandboxRollout(state)
		return nil, err
	}
	assets := &openShellDevelopmentAssets{gatewayChart: gatewayChart}
	gatewayNamespace := openShellGatewayNamespace
	if state.PlatformNamespace != "" {
		gatewayNamespace = state.PlatformNamespace
	}
	assets.workspaceResources, err = r.renderOpenShellWorkspaceResources(ctx, workspaceChart, gatewayNamespace)
	if err != nil {
		return nil, err
	}
	for _, selected := range []struct {
		component string
		source    string
		target    *string
	}{
		{"gateway", images.gateway, &assets.gatewayImage},
		{"sandbox", images.sandbox, &assets.sandboxImage},
		{"supervisor", images.supervisor, &assets.supervisorImage},
	} {
		imported, err := r.importOpenShellImage(ctx, state, root, selected.component, selected.source, images.revision != "")
		if err != nil {
			return nil, err
		}
		*selected.target = imported
	}
	return assets, nil
}

func (r *runner) renderOpenShellWorkspaceResources(ctx context.Context, chart, gatewayNamespace string) ([]any, error) {
	output, err := r.output(
		ctx,
		"helm", "template", "openshell-workspace", chart,
		"--namespace", "openclaw-workspace-template",
		"--set-string=fullnameOverride=openshell-workspace",
		"--set-string=gateway.serviceAccount.name="+openShellGatewayService,
		"--set-string=gateway.serviceAccount.namespace="+gatewayNamespace,
		"--set-string=gateway.networkPolicy.podSelector.app\\.kubernetes\\.io/instance="+openShellGatewayService,
		"--set=gateway.allowDriverConfig=true",
		"--set-string=sandboxServiceAccount.name=openshell-sandbox",
	)
	if err != nil {
		return nil, err
	}
	allowed := map[string]string{
		"ServiceAccount": "v1",
		"Role":           "rbac.authorization.k8s.io/v1",
		"RoleBinding":    "rbac.authorization.k8s.io/v1",
		"NetworkPolicy":  "networking.k8s.io/v1",
	}
	decoder := yaml.NewDecoder(strings.NewReader(string(output)))
	resources := make([]any, 0, len(allowed))
	for {
		var resource map[string]any
		if err := decoder.Decode(&resource); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("decode OpenShell workspace chart: %w", err)
		}
		if len(resource) == 0 {
			continue
		}
		kind, kindOK := resource["kind"].(string)
		apiVersion, versionOK := resource["apiVersion"].(string)
		expectedVersion, allowedKind := allowed[kind]
		metadata, metadataOK := resource["metadata"].(map[string]any)
		name, nameOK := metadata["name"].(string)
		if !kindOK || !versionOK || !allowedKind || apiVersion != expectedVersion || !metadataOK || !nameOK || strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("OpenShell workspace chart rendered an unsupported resource")
		}
		delete(metadata, "namespace")
		resources = append(resources, resource)
	}
	if len(resources) == 0 {
		return nil, fmt.Errorf("OpenShell workspace chart rendered no resources")
	}
	return resources, nil
}

func (r *runner) importOpenShellImage(ctx context.Context, state *developmentState, root, component, source string, localOnly bool) (result string, resultErr error) {
	if _, err := r.output(ctx, r.engine, "image", "inspect", source); err != nil {
		if localOnly {
			return "", fmt.Errorf("OpenShell candidate image must still exist locally at import: %s", source)
		}
		if err := r.run(ctx, r.engine, "pull", source); err != nil {
			return "", err
		}
	}
	stagingTag := "openclaw-development/openshell-" + component + ":" + state.Cluster
	if _, err := r.output(ctx, r.engine, "image", "inspect", stagingTag); err == nil {
		return "", fmt.Errorf("OpenShell development staging image already exists: %s", stagingTag)
	}
	if err := r.run(ctx, r.engine, "tag", source, stagingTag); err != nil {
		return "", err
	}
	defer func() {
		if _, err := r.output(context.WithoutCancel(ctx), r.engine, "image", "rm", stagingTag); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("remove OpenShell %s staging image: %w", component, err))
		}
	}()
	// Use the name the engine recorded for the staging tag. Podman qualifies it
	// with the `localhost` registry, and containerd stores whatever reference
	// was imported, so the verification below has to look for that name.
	recorded, err := r.engineImageReference(ctx, stagingTag)
	if err != nil {
		return "", err
	}
	platformData, err := r.output(ctx, r.engine, "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", source)
	if err != nil {
		return "", err
	}
	platform := string(platformData)
	if !strings.HasPrefix(platform, "linux/") {
		return "", fmt.Errorf("OpenShell %s image must contain a Linux platform", component)
	}
	// Docker's containerd image store cannot save a manifest-list reference
	// as one complete image (see resolveDevelopmentImageSource), so point the
	// staging tag at the platform child the list names for this host when there
	// is one.
	resolved, err := r.resolveDevelopmentImageSource(ctx, source, platform)
	if err != nil {
		return "", err
	}
	if resolved != source {
		if err := r.run(ctx, r.engine, "tag", resolved, stagingTag); err != nil {
			return "", err
		}
	}
	archive := filepath.Join(root, component+"-image.tar")
	defer func() {
		if err := os.Remove(archive); err != nil && !os.IsNotExist(err) {
			resultErr = errors.Join(resultErr, fmt.Errorf("remove OpenShell %s image archive: %w", component, err))
		}
	}()
	// The staging tag names one complete image once it points at the platform
	// child, so the archive needs no platform selection. Without a resolved
	// child, keep the platform filter: it still works where the engine can
	// resolve it, and names the failure otherwise.
	saveArgs := []string{"image", "save"}
	if r.engine == "docker" && resolved == source {
		saveArgs = append(saveArgs, "--platform", platform)
	}
	saveArgs = append(saveArgs, "--output", archive, recorded)
	if err := r.run(ctx, r.engine, saveArgs...); err != nil {
		return "", err
	}
	if err := r.importArchiveDirect(ctx, archive, state.Cluster); err != nil {
		return "", err
	}

	candidates := map[string]struct{}{
		recorded:                  {},
		stagingTag:                {},
		"docker.io/" + stagingTag: {},
	}
	server := "k3d-" + state.Cluster + "-server-0"
	data, err := r.output(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "list")
	if err != nil {
		return "", err
	}
	imported := ""
	digest := ""
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		if _, selected := candidates[fields[0]]; !selected {
			continue
		}
		if imported != "" && digest != fields[2] {
			return "", fmt.Errorf("ambiguous imported OpenShell %s image", component)
		}
		imported, digest = fields[0], fields[2]
	}
	if imported == "" || !imageDigest.MatchString(digest) {
		return "", fmt.Errorf("could not resolve imported OpenShell %s image digest", component)
	}
	untagged, _, hasTag := strings.CutLast(imported, ":")
	if !hasTag {
		return "", fmt.Errorf("imported OpenShell %s image is missing its staging tag", component)
	}
	runtimeReference := untagged + "@" + digest
	if err := r.run(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "tag", imported, runtimeReference); err != nil {
		return "", fmt.Errorf("register imported OpenShell %s image digest: %w", component, err)
	}
	fmt.Fprintf(r.opts.Out, "OpenShell %s image: source=%s containerd=%s\n", component, source, runtimeReference)
	return runtimeReference, nil
}

func (r *runner) installOpenShellGateway(ctx context.Context, state *developmentState, assets *openShellDevelopmentAssets, namespace string, timeout time.Duration) error {
	if _, err := r.output(ctx, "kubectl", "get", "namespace", namespace); err != nil {
		if err := r.run(ctx, "kubectl", "create", "namespace", namespace); err != nil {
			return err
		}
	}
	if !state.ProtectedEgress {
		if err := r.ensureOpenShellJWTSecret(ctx, state, namespace); err != nil {
			return err
		}
	}
	var protectedValues string
	if state.ProtectedEgress {
		var err error
		protectedValues, err = r.writeProtectedOpenShellValues(state)
		if err != nil {
			return err
		}
	}
	args := []string{"upgrade", "--install", openShellGatewayService, assets.gatewayChart, "--namespace", namespace, "--kubeconfig", filepath.Join(state.directory, "kubeconfig"), "--kube-context", "k3d-" + state.Cluster, "--timeout", timeout.String()}
	// The registry contacts OCC at startup. Install both releases before waiting
	// for the protected Gateway; native PKI hooks still complete synchronously.
	if !state.ProtectedEgress {
		args = append(args, "--wait")
	}
	args = append(args, openShellGatewayValues(state, assets, protectedValues)...)
	if err := r.run(ctx, "helm", args...); err != nil {
		return err
	}
	if state.DeploymentMode != "k3d" {
		data, err := r.output(ctx, "kubectl", "get", "service", openShellGatewayService, "--namespace", namespace, "-o", "jsonpath={.spec.ports[0].nodePort}")
		if err != nil {
			return err
		}
		if string(data) != fmt.Sprint(openShellNodePort) {
			return fmt.Errorf("OpenShell gateway did not retain its development NodePort")
		}
	}
	return nil
}

func openShellGatewayValues(state *developmentState, assets *openShellDevelopmentAssets, protectedValues string) []string {
	values := []string{
		"--set-string=fullnameOverride=" + openShellGatewayService,
		"--set-string=serviceAccount.name=" + openShellGatewayService,
		"--set-string=sandboxServiceAccount.name=openshell-sandbox",
		"--set=workspaceResources.enabled=false",
		"--set=server.drivers.kubernetes.allowDriverConfig=true",
		// The gateway rejects every Sandbox template label it does not allow.
		// Harness Pods carry OCE selector labels for NetworkPolicies and Services.
		openShellAllowedPodLabelsValue,
		"--set=server.drivers.kubernetes.resourceAdmission.enabled=false",
		"--set-string=server.drivers.kubernetes.workspaceMode=operator",
		"--set-string=server.drivers.kubernetes.operatorNamespaceLabel=" + openShellOperatorNamespaceLabel + "=" + openShellOperatorNamespaceValue,
		"--set=podSecurityContext.seccompProfile.type=RuntimeDefault",
		"--set-string=server.defaultRuntimeClassName=" + openShellRuntimeClass,
		"--set=gateway.image.pullPolicy=Never",
		"--set=sandboxRuntime.image.pullPolicy=Never",
		"--set=supervisor.image.pullPolicy=Never",
	}
	if protectedValues != "" {
		values = append(values, "-f", protectedValues)
	} else {
		values = append(values, "--set=pkiInitJob.enabled=false", "--set=server.disableTls=true", "--set=server.auth.allowUnauthenticatedUsers=true")
	}
	if state.DeploymentMode == "k3d" {
		values = append(values, "--set=service.type=ClusterIP")
	} else {
		values = append(values, "--set=service.type=NodePort", fmt.Sprintf("--set=service.nodePort=%d", openShellNodePort))
	}
	for _, selected := range []struct{ prefix, image string }{
		{"gateway.image", assets.gatewayImage},
		{"sandboxRuntime.image", assets.sandboxImage},
		{"supervisor.image", assets.supervisorImage},
	} {
		values = append(values, openShellImageValues(selected.prefix, selected.image)...)
	}
	return values
}

func (r *runner) openShellGatewayAddress(ctx context.Context, namespace string) (string, error) {
	data, err := r.output(
		ctx,
		"kubectl",
		"get",
		"service",
		openShellGatewayService,
		"--namespace",
		namespace,
		"-o",
		"jsonpath={.spec.clusterIP}",
	)
	if err != nil {
		return "", fmt.Errorf("resolve OpenShell Gateway address: %w", err)
	}
	address := string(data)
	if net.ParseIP(address) == nil {
		return "", fmt.Errorf("OpenShell Gateway returned an invalid ClusterIP")
	}
	return address, nil
}

func openShellImageValues(prefix, image string) []string {
	withoutDigest, digest, hasDigest := strings.Cut(image, "@")
	registry, repository, hasRegistry := strings.Cut(withoutDigest, "/")
	if !hasRegistry {
		registry = ""
		repository = withoutDigest
	}
	if untagged, _, hasTag := strings.CutLast(repository, ":"); hasTag {
		repository = untagged
	}
	values := []string{
		"--set-string=" + prefix + ".registry=" + registry,
		"--set-string=" + prefix + ".repository=" + repository,
	}
	if hasDigest {
		values = append(values, "--set-string="+prefix+".digest="+digest)
	}
	return values
}

func (r *runner) ensureOpenShellJWTSecret(ctx context.Context, state *developmentState, namespace string) error {
	root := filepath.Join(state.directory, "openshell", "jwt")
	if err := os.Mkdir(root, 0700); err != nil {
		return err
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	privateData, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return err
	}
	publicData, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		return err
	}
	kidBytes := make([]byte, 16)
	if _, err := rand.Read(kidBytes); err != nil {
		return err
	}
	files := []struct {
		name string
		data []byte
	}{
		{"signing.pem", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateData})},
		{"public.pem", pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicData})},
		{"kid", []byte("openshell-" + hex.EncodeToString(kidBytes) + "\n")},
	}
	args := []string{"create", "secret", "generic", openShellGatewayService + "-jwt-keys", "--namespace", namespace}
	for _, file := range files {
		path := filepath.Join(root, file.name)
		if err := exclusiveWrite(path, file.data, 0600); err != nil {
			return err
		}
		args = append(args, "--from-file="+file.name+"="+path)
	}
	return r.run(ctx, "kubectl", args...)
}
