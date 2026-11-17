package occdev

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	agentSandboxControllerImage = "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403"
	openShellVersion            = "0.1.8"
	openShellSourceSHA256       = "ea6c2dcb50b3ecb3c7bf3d8b5ae4ada71eee838a1a2b12f7a1d2ada76b0837b9"
	agentSandboxManifestSHA256  = "230ee446d6035f631577e1c6b857f6973a8f09a0a853675d3cc34ebfe47abd6b"
	openShellSourceArchiveURL   = "https://github.com/NVIDIA/OpenShell/archive/refs/tags/v" + openShellVersion + ".tar.gz"
	agentSandboxManifestURL     = "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox.yaml"
)

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

func (r *runner) agentSandboxManifest(ctx context.Context, root string) (string, manifestFailure, error) {
	if selected := r.env["OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST"]; selected != "" {
		if !filepath.IsAbs(selected) || filepath.Clean(selected) != selected {
			return "", manifestSelectedInput, fmt.Errorf("OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST must be an absolute canonical path")
		}
		if _, err := os.Stat(selected); err != nil {
			return "", manifestSelectedInput, fmt.Errorf("Agent Sandbox manifest is unavailable: %w", err)
		}
		return selected, "", nil
	}
	path := filepath.Join(root, "agent-sandbox-v0.5.2.yaml")
	failure, err := downloadVerifiedManifest(ctx, r.opts.Err, agentSandboxManifestURL, path, agentSandboxManifestSHA256)
	if err != nil {
		return "", failure, err
	}
	return path, "", nil
}

// Only the checksum-verified default manifest is rewritten. An explicit manifest
// retains its operator-selected image and pull policy.
func (r *runner) preloadAgentSandboxController(ctx context.Context, state *developmentState, root, manifest string) (string, error) {
	if r.env["OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST"] != "" {
		return manifest, nil
	}
	data, err := os.ReadFile(manifest)
	if err != nil {
		return "", err
	}
	// Reject a changed manifest shape before importing an image.
	if _, err := agentSandboxControllerManifest(data, agentSandboxControllerImage); err != nil {
		return "", err
	}
	nodes, err := r.output(ctx, "kubectl", "get", "nodes", "-o", "json")
	if err != nil {
		return "", err
	}
	source, selected, err := agentSandboxControllerForNodes(nodes)
	if err != nil {
		return "", err
	}
	image, err := r.importOpenShellImage(ctx, state, root, "agent-sandbox-controller", source, false, &selected)
	if err != nil {
		return "", err
	}
	data, err = agentSandboxControllerManifest(data, image)
	if err != nil {
		return "", err
	}
	local := filepath.Join(root, "agent-sandbox-local.yaml")
	if err := exclusiveWrite(local, data, 0600); err != nil {
		return "", err
	}
	return local, nil
}

func agentSandboxControllerForNodes(data []byte) (string, nativeImageSelection, error) {
	var nodes struct {
		Items []struct {
			Status struct {
				NodeInfo struct {
					OperatingSystem string `json:"operatingSystem"`
					Architecture    string `json:"architecture"`
				} `json:"nodeInfo"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &nodes); err != nil {
		return "", nativeImageSelection{}, fmt.Errorf("read Agent Sandbox node platform: %w", err)
	}
	platform := ""
	for _, node := range nodes.Items {
		selected := node.Status.NodeInfo.OperatingSystem + "/" + node.Status.NodeInfo.Architecture
		if platform != "" && selected != platform {
			return "", nativeImageSelection{}, fmt.Errorf("Agent Sandbox requires one node platform")
		}
		platform = selected
	}
	// These native manifests belong to the pinned v0.5.2 index above. Select
	// for the actual node, not a possibly foreign-platform host cache entry.
	var digest, config string
	switch platform {
	case "linux/amd64":
		config = "sha256:5b6c81129dc7491b3d260940e34ff68323fb6f7f21450d42129be5169e52ab17"
		digest = "c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6"
	case "linux/arm64":
		config = "sha256:850778443f8cc9a11d85dc345f9f8f26a1f2f651fd15271e0e2948206cc7fe67"
		digest = "7e273b836b1f7e5e33c08c68bcf539959ca2b298cb29153e1fab60fd05851248"
	default:
		return "", nativeImageSelection{}, fmt.Errorf("unsupported Agent Sandbox node platform %q", platform)
	}
	name, _, _ := strings.Cut(agentSandboxControllerImage, "@")
	return name + "@sha256:" + digest, nativeImageSelection{platform: platform, configDigest: config, cacheIndex: agentSandboxControllerImage}, nil
}

func agentSandboxControllerManifest(data []byte, image string) ([]byte, error) {
	// This exact block belongs to the pinned release, not an arbitrary YAML input.
	const controller = "      - name: agent-sandbox-controller\n        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\n"
	if strings.Count(string(data), controller) != 1 {
		return nil, fmt.Errorf("pinned Agent Sandbox manifest must contain exactly one expected controller image")
	}
	local := "      - name: agent-sandbox-controller\n        image: " + image + "\n        imagePullPolicy: Never\n"
	return []byte(strings.Replace(string(data), controller, local, 1)), nil
}

func downloadVerifiedManifest(ctx context.Context, log io.Writer, url, destination, expected string) (manifestFailure, error) {
	data, failure, err := downloadDevelopmentManifestOutcome(ctx, log, filepath.Base(destination), url, expected, developmentManifestRetry)
	if err != nil {
		return failure, err
	}
	if err := exclusiveWrite(destination, data, 0600); err != nil {
		return manifestLocalIO, err
	}
	return "", nil
}

func downloadVerified(ctx context.Context, url, destination, expected string) error {
	policy := developmentManifestRetry
	started := time.Now()
	delay := policy.firstDelay
	for attempt := 1; ; attempt++ {
		transient, err := downloadArchiveAttempt(ctx, url, destination, expected)
		if err == nil {
			return nil
		}
		if !transient || attempt >= policy.attempts || time.Since(started)+delay > policy.budget {
			return fmt.Errorf("%w (after %d attempt(s))", err, attempt)
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("download archive: %w", context.Cause(ctx))
		case <-timer.C:
		}
		delay = min(delay*2, policy.maxDelay)
	}
}

func downloadArchiveAttempt(ctx context.Context, url, destination, expected string) (transient bool, result error) {
	attemptCtx, cancel := context.WithTimeout(ctx, developmentManifestRetry.attemptTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return transientManifestError(ctx, err), fmt.Errorf("download %s failed: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		status := response.StatusCode
		return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500 && status <= 599,
			fmt.Errorf("download %s failed: HTTP %d", url, status)
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return false, err
	}
	defer func() {
		if result != nil {
			// Only this attempt's exclusive file may be removed. A failed
			// cleanup must stop retries rather than reuse unverified bytes.
			if err := os.Remove(destination); err != nil {
				transient = false
				result = errors.Join(result, err)
			}
		}
	}()
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(file, hash), response.Body)
	closeErr := file.Close()
	if copyErr != nil {
		if closeErr != nil {
			return false, errors.Join(copyErr, closeErr)
		}
		var fileError *os.PathError
		return !errors.As(copyErr, &fileError) && transientManifestError(ctx, copyErr), copyErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return false, fmt.Errorf("checksum mismatch for %s: expected %s, got %s", filepath.Base(destination), expected, actual)
	}
	return false, nil
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
