package occdev

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json/v2"
	"encoding/pem"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"go.yaml.in/yaml/v3"
)

const developmentNamespacePlaceholder = "${OCC_INITIAL_NAMESPACE_ID}"
const developmentRepositoryImage = "openclaw-enterprise-repository-credentials:kubernetes-quickstart"

var developmentBackendID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type developmentRepositoryInputs struct {
	registry      map[string]any
	backendID     string
	upstreamCIDRs []string
	appKey        []byte
}

// loadDevelopmentRepositoryInputs admits only explicitly scoped operator input.
// The sole placeholder is replaced with the Namespace OCC actually bootstraps.
func (r *runner) loadDevelopmentRepositoryInputs(sandboxDriver string) (*developmentRepositoryInputs, error) {
	directory := r.env["OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY"]
	if directory == "" {
		if r.env["OCC_DEVELOPMENT_REPOSITORY_IMAGE"] != "" {
			return nil, fmt.Errorf("OCC_DEVELOPMENT_REPOSITORY_IMAGE requires OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY")
		}
		return nil, nil
	}
	if sandboxDriver != "none" {
		return nil, fmt.Errorf("repository credentials require the Kubernetes profile without a Sandbox Driver")
	}
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return nil, fmt.Errorf("repository input directory must be an absolute canonical path")
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil || resolved != directory {
		return nil, fmt.Errorf("repository input directory must exist without symlinks")
	}
	if err := privateOwned(directory, true); err != nil {
		return nil, fmt.Errorf("repository input directory must be private (mode 0700)")
	}
	read := func(name string, private bool) ([]byte, error) {
		path := filepath.Join(directory, name)
		before, err := os.Lstat(path)
		if err != nil || !before.Mode().IsRegular() || (private && privateOwned(path, false) != nil) {
			return nil, fmt.Errorf("repository input %s must be a regular private file", name)
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("open repository input %s: %w", name, err)
		}
		defer file.Close()
		after, err := file.Stat()
		if err != nil || !os.SameFile(before, after) {
			return nil, fmt.Errorf("repository input %s changed while opening", name)
		}
		if after.Size() > 1024*1024 {
			return nil, fmt.Errorf("repository input %s exceeds 1 MiB", name)
		}
		data, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
		if err != nil || int64(len(data)) != after.Size() {
			return nil, fmt.Errorf("repository input %s changed while reading", name)
		}
		return data, nil
	}
	registryData, err := read("registry.json", false)
	if err != nil {
		return nil, err
	}
	registry := map[string]any{}
	if err := json.Unmarshal(registryData, &registry); err != nil {
		return nil, fmt.Errorf("invalid repository registry JSON")
	}
	duration, ok := registry["maximumDurationSeconds"].(float64)
	if !ok || duration < 1 || duration > 9007199254740 || math.Trunc(duration) != duration {
		return nil, fmt.Errorf("repository maximumDurationSeconds must be a positive safe integer")
	}
	backendID, ok := registry["backendId"].(string)
	if !ok || !developmentBackendID.MatchString(backendID) {
		return nil, fmt.Errorf("repository registry requires a valid backendId")
	}
	repositories, ok := registry["repositories"].([]any)
	if !ok || len(repositories) == 0 {
		return nil, fmt.Errorf("repository registry requires explicitly approved repositories")
	}
	seenReferences := map[string]bool{}
	for _, entry := range repositories {
		repository, ok := entry.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid repository registry entry")
		}
		reference, ok := repository["repositoryRef"].(string)
		if !ok || !developmentBackendID.MatchString(reference) || seenReferences[reference] {
			return nil, fmt.Errorf("repository references must be valid and unique")
		}
		seenReferences[reference] = true
		namespaces, ok := repository["namespaces"].([]any)
		if !ok || len(namespaces) != 1 {
			return nil, fmt.Errorf("each repository must contain exactly one initial Namespace policy")
		}
		policy, ok := namespaces[0].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid repository Namespace policy")
		}
		policyNamespace, ok := policy["namespaceId"].(string)
		if !ok || policyNamespace != developmentNamespacePlaceholder {
			return nil, fmt.Errorf("each repository Namespace policy must use %s", developmentNamespacePlaceholder)
		}
		profiles, ok := policy["profiles"].([]any)
		if !ok || len(profiles) == 0 {
			return nil, fmt.Errorf("repository profiles must be explicitly approved")
		}
		seenProfiles := map[string]bool{}
		for _, profile := range profiles {
			name, ok := profile.(string)
			if !ok || (name != "git-read" && name != "git-write" && name != "git-full") || seenProfiles[name] {
				return nil, fmt.Errorf("repository profiles must be supported and unique")
			}
			seenProfiles[name] = true
		}
	}
	cidrData, err := read("upstream-cidrs.json", false)
	if err != nil {
		return nil, err
	}
	var cidrs []string
	if err := json.Unmarshal(cidrData, &cidrs); err != nil || len(cidrs) == 0 {
		return nil, fmt.Errorf("repository upstream-cidrs.json must contain approved IPv4 /32 endpoints")
	}
	for _, value := range cidrs {
		prefix, err := netip.ParsePrefix(value)
		if err != nil || !prefix.Addr().Is4() || prefix.Bits() != 32 || prefix != prefix.Masked() {
			return nil, fmt.Errorf("repository upstream CIDRs must be canonical IPv4 /32 endpoints")
		}
	}
	key, err := read("private-key.pem", true)
	if err != nil {
		return nil, err
	}
	if len(key) > 65536 {
		return nil, fmt.Errorf("repository App key exceeds the credential service limit")
	}
	block, rest := pem.Decode(key)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, fmt.Errorf("repository App key must contain one RSA private key")
	}
	parsed, parseErr := x509.ParsePKCS8PrivateKey(block.Bytes)
	if parseErr != nil {
		parsed, parseErr = x509.ParsePKCS1PrivateKey(block.Bytes)
	}
	rsaKey, ok := parsed.(*rsa.PrivateKey)
	if parseErr != nil || !ok || (rsaKey.N.BitLen() < 2048 || rsaKey.N.BitLen() > 8192) {
		return nil, fmt.Errorf("repository App key must be an RSA private key of 2048 to 8192 bits")
	}
	return &developmentRepositoryInputs{registry: registry, backendID: backendID, upstreamCIDRs: cidrs, appKey: key}, nil
}

func (r *runner) validateDevelopmentRepositoryImage(ctx context.Context) error {
	image := r.env["OCC_DEVELOPMENT_REPOSITORY_IMAGE"]
	if image == "" {
		return nil
	}
	name, digest, found := strings.Cut(image, "@")
	if !found || name == "" || strings.ContainsAny(name, " \t\n\r@") || !imageDigest.MatchString(digest) {
		return fmt.Errorf("selected repository service image must use an immutable sha256 digest")
	}
	checkout, err := r.output(ctx, "git", "rev-parse", "--verify", "HEAD")
	if err != nil {
		return fmt.Errorf("resolve the checkout revision for selected repository service image: %w", err)
	}
	revision := string(checkout)
	if len(revision) != 40 || strings.Trim(revision, "0123456789abcdef") != "" {
		return fmt.Errorf("the checkout must have a full Git commit revision")
	}
	label, err := r.output(ctx, r.engine, "image", "inspect", "--format", `{{ index .Config.Labels "org.opencontainers.image.revision" }}`, image)
	if err != nil || string(label) != revision {
		return fmt.Errorf("repository service image must exist locally and match the checkout revision")
	}
	return nil
}

func (r *runner) importDevelopmentRepositoryService(ctx context.Context, state *developmentState) (string, error) {
	image := r.setting("OCC_DEVELOPMENT_REPOSITORY_IMAGE", developmentRepositoryImage)
	if r.env["OCC_DEVELOPMENT_REPOSITORY_IMAGE"] == "" {
		if err := r.run(ctx, r.engine, "build", "-f", "deploy/runtime/Dockerfile", "--target", "repository-credentials-service", "--tag", image, "."); err != nil {
			return "", err
		}
	}
	return r.importDevelopmentImage(ctx, state, image)
}

// Generate a private local CA and a server leaf for the chart's exact broker
// hostname. The CA key remains in the private development state directory.
func writeDevelopmentRepositoryTLS(directory, hostname string) error {
	return writeDevelopmentTLS(directory, "repository", "OCC development repository CA", []string{hostname})
}

func writeDevelopmentTLS(directory, prefix, subject string, hostnames []string) error {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial := func() (*big.Int, error) { return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)) }
	caSerial, err := serial()
	if err != nil {
		return err
	}
	leafSerial, err := serial()
	if err != nil {
		return err
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: caSerial, Subject: pkix.Name{CommonName: subject}, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(1, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	leaf := &x509.Certificate{SerialNumber: leafSerial, DNSNames: hostnames, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(0, 3, 0), BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	caPrivate, err := x509.MarshalPKCS8PrivateKey(caKey)
	if err != nil {
		return err
	}
	leafPrivate, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		return err
	}
	files := map[string][]byte{
		prefix + "-ca.crt":  pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		prefix + "-ca.key":  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: caPrivate}),
		prefix + "-tls.crt": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		prefix + "-tls.key": pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: leafPrivate}),
	}
	for name, data := range files {
		if err := exclusiveWrite(filepath.Join(directory, name), data, 0600); err != nil {
			return err
		}
	}
	return nil
}

func replaceDevelopmentFile(path string, data []byte) error {
	temporary := path + ".next"
	if err := exclusiveWrite(temporary, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	return nil
}

func (r *runner) enableDevelopmentRepository(ctx context.Context, state *developmentState, inputs *developmentRepositoryInputs, image, namespaceID string, client *occclient.Client, timeout time.Duration) error {
	for _, entry := range inputs.registry["repositories"].([]any) {
		entry.(map[string]any)["namespaces"].([]any)[0].(map[string]any)["namespaceId"] = namespaceID
	}
	registry, err := json.Marshal(inputs.registry)
	if err != nil {
		return err
	}
	namespace := state.PlatformNamespace
	hostname := "git." + namespace + ".svc.cluster.local"
	if err := writeDevelopmentRepositoryTLS(state.directory, hostname); err != nil {
		return err
	}
	config, err := json.Marshal(map[string]any{
		"gateway":       map[string]any{"listen": "0.0.0.0:8443", "controlSocket": "/run/openclaw/repository-control/private/control.sock"},
		"sessionPolicy": map[string]any{"maximumDurationSeconds": inputs.registry["maximumDurationSeconds"], "defaultProfile": "git-write", "allowedProfiles": []string{"git-read", "git-write", "git-full"}},
		"backend":       map[string]any{"kind": "github-app-registry", "backendId": inputs.backendID},
	})
	if err != nil {
		return err
	}
	for name, data := range map[string][]byte{"repository-service.json": config, "repository-app-key.pem": inputs.appKey} {
		if err := exclusiveWrite(filepath.Join(state.directory, name), data, 0600); err != nil {
			return err
		}
	}
	labels := map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}
	registryObject := map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": kubernetesMetadata("occ-repository-registry-v1", namespace, labels), "immutable": true, "data": map[string]string{"registry.json": string(registry)}}
	if err := r.writeAndApply(ctx, state, "repository-registry", registryObject); err != nil {
		return err
	}
	secrets := [][]string{
		{"generic", "occ-repository-service", "--from-file=config.json=" + filepath.Join(state.directory, "repository-service.json")},
		{"generic", "occ-repository-app", "--from-file=private-key.pem=" + filepath.Join(state.directory, "repository-app-key.pem")},
		{"generic", "occ-repository-ca", "--from-file=ca.crt=" + filepath.Join(state.directory, "repository-ca.crt")},
		{"tls", "occ-repository-tls", "--cert=" + filepath.Join(state.directory, "repository-tls.crt"), "--key=" + filepath.Join(state.directory, "repository-tls.key")},
	}
	for _, args := range secrets {
		if err := r.run(ctx, "kubectl", append([]string{"-n", namespace, "create", "secret"}, args...)...); err != nil {
			return err
		}
	}
	installationPath := filepath.Join(state.directory, "installation.yaml")
	installationData, err := os.ReadFile(installationPath)
	if err != nil {
		return err
	}
	var installation map[string]any
	if err := yaml.Unmarshal(installationData, &installation); err != nil {
		return err
	}
	drivers, ok := installation["drivers"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Installation has no Drivers")
	}
	drivers["repo"] = map[string]any{"id": "repository-credentials", "configuration": map[string]any{"controlSocket": "/run/openclaw/repository-control/private/control.sock", "sessionDurationSeconds": inputs.registry["maximumDurationSeconds"], "publicCaPath": "/etc/openclaw/repository-ca/ca.crt"}}
	installation["backend"] = []any{map[string]any{"id": inputs.backendID, "type": "github", "configuration": map[string]any{"registryPath": "/etc/openclaw/repository-registry/registry.json"}, "drivers": map[string]string{"repo": "repository-credentials"}}}
	computeDriver, ok := drivers["compute"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Installation has no Compute Driver")
	}
	compute, ok := computeDriver["configuration"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Compute Driver has no configuration")
	}
	network, ok := compute["network"].(map[string]any)
	if !ok {
		return fmt.Errorf("development Compute Driver has no network configuration")
	}
	network["repositoryCredentials"] = map[string]any{"namespace": namespace, "podLabels": map[string]string{"app.kubernetes.io/name": "openclaw-enterprise", "app.kubernetes.io/instance": "openclaw-enterprise", "app.kubernetes.io/component": "worker"}, "port": 8443}
	installationData, err = yaml.Marshal(installation)
	if err != nil {
		return err
	}
	if err := replaceDevelopmentFile(installationPath, installationData); err != nil {
		return err
	}
	startupSecret := map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": kubernetesMetadata("occ-installation-startup", namespace, labels), "stringData": map[string]string{"installation.yaml": string(installationData)}}
	if err := r.writeAndApply(ctx, state, "repository-installation-secret", startupSecret); err != nil {
		return err
	}
	valuesPath := filepath.Join(state.directory, "helm-values.json")
	valuesData, err := os.ReadFile(valuesPath)
	if err != nil {
		return err
	}
	var values map[string]any
	if err := json.Unmarshal(valuesData, &values); err != nil {
		return err
	}
	values["repositoryCredentials"] = map[string]any{"enabled": true, "image": image, "serviceName": "git", "backendId": inputs.backendID, "registryConfigMapName": "occ-repository-registry-v1", "serviceConfigSecretName": "occ-repository-service", "appKeySecretName": "occ-repository-app", "tlsSecretName": "occ-repository-tls", "publicCaSecretName": "occ-repository-ca", "upstreamCidrs": inputs.upstreamCIDRs}
	valuesData, err = json.Marshal(values)
	if err != nil {
		return err
	}
	if err := replaceDevelopmentFile(valuesPath, valuesData); err != nil {
		return err
	}
	if err := r.run(ctx, "helm", "upgrade", "openclaw-enterprise", "deploy/helm/openclaw-enterprise", "--namespace", namespace, "--kubeconfig", filepath.Join(state.directory, "kubeconfig"), "--kube-context", "k3d-"+state.Cluster, "-f", valuesPath, "--wait", "--timeout", timeout.String()); err != nil {
		return err
	}
	if err := r.run(ctx, "kubectl", "-n", namespace, "rollout", "status", "deployment/openclaw-enterprise-worker", "--timeout", timeout.String()); err != nil {
		return err
	}
	expected := map[string]map[string]bool{}
	for _, entry := range inputs.registry["repositories"].([]any) {
		repository := entry.(map[string]any)
		policy := repository["namespaces"].([]any)[0].(map[string]any)
		profiles := map[string]bool{}
		for _, profile := range policy["profiles"].([]any) {
			profiles[profile.(string)] = true
		}
		expected[repository["repositoryRef"].(string)] = profiles
	}
	return waitForDevelopmentRepositories(ctx, client, namespaceID, expected, timeout)
}

func waitForDevelopmentRepositories(ctx context.Context, client *occclient.Client, namespaceID string, expected map[string]map[string]bool, timeout time.Duration) error {
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		options, err := client.WithContext(ctx).ListRepositoryOptions(namespaceID)
		if err != nil {
			return false, nil
		}
		list, ok := options.([]any)
		if !ok {
			return false, fmt.Errorf("invalid repository discovery response")
		}
		actual := map[string]map[string]bool{}
		for _, entry := range list {
			option, ok := entry.(map[string]any)
			if !ok {
				return false, fmt.Errorf("invalid repository discovery option")
			}
			reference, ok := option["repositoryRef"].(string)
			if !ok || actual[reference] != nil {
				return false, fmt.Errorf("invalid repository discovery reference")
			}
			profileList, ok := option["allowedProfiles"].([]any)
			if !ok {
				return false, fmt.Errorf("invalid repository discovery profiles")
			}
			profiles := map[string]bool{}
			for _, item := range profileList {
				profile, ok := item.(string)
				if !ok || profiles[profile] {
					return false, fmt.Errorf("invalid repository discovery profile")
				}
				profiles[profile] = true
			}
			actual[reference] = profiles
		}
		if !reflect.DeepEqual(actual, expected) {
			return false, fmt.Errorf("repository discovery does not match the approved registry")
		}
		return true, nil
	})
}
