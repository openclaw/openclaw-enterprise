package occdev

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

const (
	openShellVersion                = "0.1.3-pre.2"
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
	openShellSourceSHA256           = "77afc69ad28e55f11a05cbc68d6dc5a6cc5c989a68d0f9d55ae0868af2b3f476"
	agentSandboxManifestSHA256      = "230ee446d6035f631577e1c6b857f6973a8f09a0a853675d3cc34ebfe47abd6b"
	openShellK3sImage               = "docker.io/rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657"
	openShellGatewayImage           = "ghcr.io/nvidia/openshell/gateway:021400be8af471f8669369e679de3e18cf0bd672@sha256:17b2f65d1e33f32a419ecc98dd42389b0227280be54139c14834933ec29420ea"
	openShellSandboxImage           = "ghcr.io/nvidia/openshell/sandbox:021400be8af471f8669369e679de3e18cf0bd672@sha256:b46ed57b080946d0fe80490dbe1441ebf4a83c6eec79369ddbcfc49ec19dc0cf"
	openShellSupervisorImage        = "ghcr.io/nvidia/openshell/supervisor:021400be8af471f8669369e679de3e18cf0bd672@sha256:971d71f45f677a7b1084385322bae4ac6fd09e9450e680684ab79a04d07c5c9f"
	openShellSourceArchiveURL       = "https://github.com/NVIDIA/OpenShell/archive/refs/tags/v" + openShellVersion + ".tar.gz"
	agentSandboxManifestURL         = "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox.yaml"
	openShellAdmissionContainerPath = "/etc/openclaw-development/openshell-pod-security-admission.yaml"
)

type openShellDevelopmentAssets struct {
	gatewayChart       string
	workspaceResources []any
	gatewayImage       string
	sandboxImage       string
	supervisorImage    string
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
		{"gateway", openShellGatewayImage, &assets.gatewayImage},
		{"sandbox", openShellSandboxImage, &assets.sandboxImage},
		{"supervisor", openShellSupervisorImage, &assets.supervisorImage},
	} {
		imported, err := r.importOpenShellImage(ctx, state, root, selected.component, selected.source)
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

func (r *runner) importOpenShellImage(ctx context.Context, state *developmentState, root, component, source string) (result string, resultErr error) {
	if _, err := r.output(ctx, r.engine, "image", "inspect", source); err != nil {
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
	archive := filepath.Join(root, component+"-image.tar")
	defer func() {
		if err := os.Remove(archive); err != nil && !os.IsNotExist(err) {
			resultErr = errors.Join(resultErr, fmt.Errorf("remove OpenShell %s image archive: %w", component, err))
		}
	}()
	saveArgs := []string{"image", "save"}
	if r.engine == "docker" {
		saveArgs = append(saveArgs, "--platform", platform)
	}
	saveArgs = append(saveArgs, "--output", archive, recorded)
	if err := r.run(ctx, r.engine, saveArgs...); err != nil {
		return "", err
	}
	if err := r.run(ctx, "k3d", "image", "import", "--mode", "direct", archive, "-c", state.Cluster); err != nil {
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
	return runtimeReference, nil
}

func (r *runner) openShellCharts(ctx context.Context, root string) (string, string, error) {
	gatewaySelected := r.env["OCC_DEVELOPMENT_OPENSHELL_HELM_CHART"]
	workspaceSelected := r.env["OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART"]
	if gatewaySelected != "" || workspaceSelected != "" {
		if gatewaySelected == "" || workspaceSelected == "" {
			return "", "", fmt.Errorf("both OpenShell development Helm charts must be selected together")
		}
		for _, selected := range []struct {
			name string
			path string
		}{
			{"OCC_DEVELOPMENT_OPENSHELL_HELM_CHART", gatewaySelected},
			{"OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART", workspaceSelected},
		} {
			if !filepath.IsAbs(selected.path) || filepath.Clean(selected.path) != selected.path {
				return "", "", fmt.Errorf("%s must be an absolute canonical path", selected.name)
			}
			if _, err := os.Stat(selected.path); err != nil {
				return "", "", fmt.Errorf("OpenShell Helm chart is unavailable: %w", err)
			}
			if _, err := r.output(ctx, "helm", "show", "chart", selected.path); err != nil {
				return "", "", err
			}
		}
		return gatewaySelected, workspaceSelected, nil
	}
	sourceArchive := filepath.Join(root, "openshell-source.tar.gz")
	if err := downloadVerified(ctx, openShellSourceArchiveURL, sourceArchive, openShellSourceSHA256); err != nil {
		return "", "", err
	}
	sourceRoot := filepath.Join(root, "source")
	if err := os.Mkdir(sourceRoot, 0700); err != nil {
		return "", "", err
	}
	prefix := "OpenShell-" + openShellVersion + "/deploy/helm"
	if err := extractArchiveSubtree(sourceArchive, sourceRoot, prefix); err != nil {
		return "", "", err
	}
	packageDirectory := filepath.Join(root, "chart")
	if err := os.Mkdir(packageDirectory, 0700); err != nil {
		return "", "", err
	}
	charts := make([]string, 0, 2)
	for _, name := range []string{"openshell", "openshell-workspace"} {
		chartDirectory := filepath.Join(sourceRoot, filepath.FromSlash(prefix), name)
		output, err := r.output(ctx, "helm", "package", chartDirectory, "--version", openShellVersion, "--app-version", openShellVersion, "--destination", packageDirectory)
		if err != nil {
			return "", "", err
		}
		fields := strings.Fields(string(output))
		if len(fields) == 0 {
			return "", "", fmt.Errorf("OpenShell Helm packaging returned no chart path")
		}
		chart := fields[len(fields)-1]
		if !filepath.IsAbs(chart) {
			chart = filepath.Join(packageDirectory, filepath.Base(chart))
		}
		if _, err := r.output(ctx, "helm", "show", "chart", chart); err != nil {
			return "", "", err
		}
		charts = append(charts, chart)
	}
	return charts[0], charts[1], nil
}

func (r *runner) agentSandboxManifest(ctx context.Context, root string) (string, error) {
	if selected := r.env["OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST"]; selected != "" {
		if !filepath.IsAbs(selected) || filepath.Clean(selected) != selected {
			return "", fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST must be an absolute canonical path")
		}
		if _, err := os.Stat(selected); err != nil {
			return "", fmt.Errorf("Agent Sandbox manifest is unavailable: %w", err)
		}
		return selected, nil
	}
	path := filepath.Join(root, "agent-sandbox-v0.5.2.yaml")
	if err := downloadVerified(ctx, agentSandboxManifestURL, path, agentSandboxManifestSHA256); err != nil {
		return "", err
	}
	return path, nil
}

func downloadVerified(ctx context.Context, url, destination, expected string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("download %s failed: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s failed: HTTP %d", url, response.StatusCode)
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(file, hash), response.Body)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum mismatch for %s: expected %s, got %s", filepath.Base(destination), expected, actual)
	}
	return nil
}

func extractArchiveSubtree(archive, destination, prefix string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	found := false
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if header.Name != prefix && !strings.HasPrefix(header.Name, prefix+"/") {
			continue
		}
		clean := filepath.Clean(filepath.FromSlash(header.Name))
		target := filepath.Join(destination, clean)
		relative, err := filepath.Rel(destination, target)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("OpenShell source archive contains an unsafe path")
		}
		found = true
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return err
			}
			output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(output, reader)
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		default:
			return fmt.Errorf("OpenShell source archive contains unsupported entry %s", header.Name)
		}
	}
	if !found {
		return fmt.Errorf("OpenShell source archive does not contain %s", prefix)
	}
	return nil
}

func (r *runner) installOpenShellGateway(ctx context.Context, state *developmentState, assets *openShellDevelopmentAssets, namespace string, timeout time.Duration) error {
	if _, err := r.output(ctx, "kubectl", "get", "namespace", namespace); err != nil {
		if err := r.run(ctx, "kubectl", "create", "namespace", namespace); err != nil {
			return err
		}
	}
	if err := r.ensureOpenShellJWTSecret(ctx, state, namespace); err != nil {
		return err
	}
	values := []string{
		"--set-string=fullnameOverride=" + openShellGatewayService,
		"--set=pkiInitJob.enabled=false",
		"--set=server.disableTls=true",
		"--set=server.auth.allowUnauthenticatedUsers=true",
		"--set-string=serviceAccount.name=" + openShellGatewayService,
		"--set-string=sandboxServiceAccount.name=openshell-sandbox",
		"--set=workspaceResources.enabled=false",
		"--set=server.drivers.kubernetes.allowDriverConfig=true",
		"--set=server.drivers.kubernetes.resourceAdmission.enabled=false",
		"--set-string=server.drivers.kubernetes.workspaceMode=operator",
		"--set-string=server.drivers.kubernetes.operatorNamespaceLabel=" + openShellOperatorNamespaceLabel + "=" + openShellOperatorNamespaceValue,
		"--set=podSecurityContext.seccompProfile.type=RuntimeDefault",
		"--set-string=server.defaultRuntimeClassName=" + openShellRuntimeClass,
		"--set=gateway.image.pullPolicy=Never",
		"--set=sandboxRuntime.image.pullPolicy=Never",
		"--set=supervisor.image.pullPolicy=Never",
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
	args := []string{"upgrade", "--install", openShellGatewayService, assets.gatewayChart, "--namespace", namespace, "--kubeconfig", filepath.Join(state.directory, "kubeconfig"), "--kube-context", "k3d-" + state.Cluster, "--wait", "--timeout", timeout.String()}
	args = append(args, values...)
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
