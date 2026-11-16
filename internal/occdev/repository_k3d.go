package occdev

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json/v2"
	"encoding/pem"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/devtls"
	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"go.yaml.in/yaml/v3"
)

const developmentNamespacePlaceholder = "${OCC_INITIAL_NAMESPACE_ID}"
const developmentRepositoryImage = "openclaw-enterprise-repository-credentials:kubernetes-quickstart"

var developmentBackendID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type developmentRepositoryInputs struct {
	registry       map[string]any
	backendID      string
	upstreamCIDRs  []string
	appKey         []byte
	preparedOrigin string
	preparedPort   int
	issuerCA       []byte
}

// loadDevelopmentRepositoryInputs admits only explicitly scoped operator input.
// The sole placeholder is replaced with the Namespace OCC actually bootstraps.
func (r *runner) loadDevelopmentRepositoryInputs(sandboxDriver string) (*developmentRepositoryInputs, error) {
	directory := r.env["OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY"]
	origin := r.env["OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN"]
	var port int
	if origin != "" {
		host := r.env["OCC_DEVELOPMENT_PREPARED_GIT_HOST_IP"]
		u, err := url.Parse(origin)
		ip, ipErr := netip.ParseAddr(host)
		if directory == "" || sandboxDriver != "none" || r.env["OCC_DEVELOPMENT_PROTECTED_EGRESS"] == "1" ||
			err != nil || ipErr != nil || !ip.IsPrivate() || !ip.Is4() || u.Hostname() != host || origin != "https://"+u.Host {
			return nil, fmt.Errorf("prepared Git qualification requires the Compute-owned profile without a Sandbox Driver and the exact private fixture HTTPS origin")
		}
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1024 || port > 65535 {
			return nil, fmt.Errorf("prepared Git fixture requires an explicit unprivileged HTTPS port")
		}
	}
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
		// The worker and broker prepare only one exact writable branch per grant and
		// refuse any other policy at startup, after the cluster effects.
		refs, _ := policy["pushRefAllowlist"].([]any)
		var ref string
		if len(refs) == 1 {
			ref, _ = refs[0].(string)
		}
		base, _ := policy["pullRequestBase"].(string)
		_, hasBase := policy["pullRequestBase"]
		transportOK := (policy["transport"] == "git-only" && !hasBase) ||
			(policy["transport"] == "git-and-draft-pr" && base != "" && ref != "refs/heads/"+base)
		if !transportOK || !reflect.DeepEqual(profiles, []any{"git-write"}) || !strings.HasPrefix(ref, "refs/heads/") ||
			len(ref) <= len("refs/heads/") || strings.Contains(ref, "*") {
			return nil, fmt.Errorf("prepared repository access requires profiles [\"git-write\"], exactly one exact pushRefAllowlist branch, and transport git-only or git-and-draft-pr with a different pullRequestBase")
		}
		if origin != "" && (!strings.HasPrefix(ref, "refs/heads/review/") || len(ref) <= len("refs/heads/review/") ||
			(policy["transport"] == "git-and-draft-pr" && base != "main")) {
			return nil, fmt.Errorf("prepared Git qualification requires explicit Git or draft PR transport, git-write and one review ref")
		}
	}
	cidrData, err := read("upstream-cidrs.json", false)
	if err != nil {
		return nil, err
	}
	cidrs, err := repositoryUpstreamCIDRs(cidrData, origin != "", repositoryMetaClient)
	if err != nil {
		return nil, err
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
	inputs := &developmentRepositoryInputs{registry: registry, backendID: backendID, upstreamCIDRs: cidrs, appKey: key}
	if origin != "" {
		if !reflect.DeepEqual(cidrs, []string{r.env["OCC_DEVELOPMENT_PREPARED_GIT_HOST_IP"] + "/32"}) {
			return nil, fmt.Errorf("prepared Git fixture must select exactly its private HTTPS address")
		}
		ca, err := read("issuer-ca.crt", false)
		if err != nil {
			return nil, err
		}
		inputs.preparedOrigin, inputs.preparedPort, inputs.issuerCA = origin, port, ca
	}
	return inputs, nil
}

var nonPublicRepositoryNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

// Local endpoint lists grant individual hosts. Hosted QA supplies the API and Git
// networks selected from GitHub Meta; private issuer fixtures always use a single host.
func repositoryUpstreamCIDRs(data []byte, privateIssuer bool, client *http.Client) ([]string, error) {
	var cidrs []string
	published := false
	if err := json.Unmarshal(data, &cidrs); err != nil {
		if privateIssuer {
			return nil, fmt.Errorf("private repository issuer requires an explicit endpoint list")
		}
		var source struct {
			GitHubAPIAndGit []string `json:"githubApiAndGit"`
		}
		if err := json.Unmarshal(data, &source); err != nil {
			return nil, fmt.Errorf("invalid repository egress input")
		}
		cidrs = source.GitHubAPIAndGit
		published = true
	}
	if len(cidrs) == 0 {
		return nil, fmt.Errorf("repository egress input must contain IPv4 destinations")
	}
	for _, value := range cidrs {
		prefix, err := netip.ParsePrefix(value)
		if err != nil || !prefix.Addr().Is4() || prefix != prefix.Masked() || prefix.Bits() == 0 {
			return nil, fmt.Errorf("repository egress requires canonical IPv4 CIDRs")
		}
		if !published && prefix.Bits() != 32 {
			return nil, fmt.Errorf("explicit repository endpoints must be IPv4 /32 addresses")
		}
		if published {
			// Check the entire network. A public first address can still cover private hosts.
			for _, reserved := range nonPublicRepositoryNetworks {
				if prefix.Overlaps(reserved) {
					return nil, fmt.Errorf("GitHub egress requires public IPv4 networks")
				}
			}
		}
	}
	if published {
		if err := verifyPublishedRepositoryCIDRs(cidrs, client); err != nil {
			return nil, err
		}
	}
	return cidrs, nil
}

var repositoryMetaClient = &http.Client{
	Timeout:       15 * time.Second,
	Transport:     &http.Transport{Proxy: nil},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// Verify exact entries against GitHub itself before granting the worker egress.
// A caller can select a subset, but cannot add another network or a broader prefix.
func verifyPublishedRepositoryCIDRs(cidrs []string, client *http.Client) error {
	response, err := client.Get("https://api.github.com/meta")
	if err != nil {
		return fmt.Errorf("verify GitHub repository egress ranges: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("verify GitHub repository egress ranges: HTTP %d", response.StatusCode)
	}
	const maxBytes = 4 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil || len(body) > maxBytes {
		return fmt.Errorf("cannot read GitHub repository network metadata within %d bytes", maxBytes)
	}
	var meta struct {
		API []string `json:"api"`
		Git []string `json:"git"`
	}
	if err := json.Unmarshal(body, &meta); err != nil || len(meta.API) == 0 || len(meta.Git) == 0 {
		return fmt.Errorf("GitHub repository network metadata must contain API and Git ranges")
	}
	for _, cidr := range cidrs {
		if !slices.Contains(meta.API, cidr) && !slices.Contains(meta.Git, cidr) {
			return fmt.Errorf("repository range %s is absent from GitHub's current API and Git ranges", cidr)
		}
	}
	return nil
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
// hostname.
func writeDevelopmentRepositoryTLS(directory, hostname string) error {
	return writeDevelopmentTLS(directory, "repository", "OCC development repository CA", []string{hostname})
}

// writeDevelopmentTLS writes a CA certificate and one server leaf with its key.
// The CA key never reaches disk: it signs the leaf in memory and is dropped, so
// a CA that developers trust in their browser cannot sign anything else later.
func writeDevelopmentTLS(directory, prefix, subject string, hostnames []string) error {
	files, _, err := devtls.Generate(prefix, subject, hostnames)
	if err != nil {
		return err
	}
	for name, data := range files {
		if err := exclusiveWrite(filepath.Join(directory, name), data, 0600); err != nil {
			return err
		}
	}
	return nil
}

func replaceDevelopmentFile(path string, data []byte) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("development file must be regular: %s", path)
	}
	temporary := path + ".next"
	if err := exclusiveWrite(temporary, data, info.Mode().Perm()); err != nil {
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
	const preparedCA = "/etc/openclaw/prepared-repository-ca/ca.crt"
	backend := map[string]any{"kind": "github-prepared-git-registry", "backendId": inputs.backendID}
	if inputs.preparedOrigin != "" {
		backend["gitOrigin"], backend["apiOrigin"], backend["gitCaFile"] = inputs.preparedOrigin, inputs.preparedOrigin, preparedCA
	}
	config, err := json.Marshal(map[string]any{
		"gateway":       map[string]any{"listen": "0.0.0.0:8443", "controlSocket": "/run/openclaw/repository-control/private/control.sock"},
		"sessionPolicy": map[string]any{"maximumDurationSeconds": inputs.registry["maximumDurationSeconds"], "defaultProfile": "git-write", "allowedProfiles": []string{"git-write"}},
		"backend":       backend,
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
	// The worker's custody key seals the installation tokens it prepares.
	custody := make([]byte, 32)
	if _, err := rand.Read(custody); err != nil {
		return err
	}
	custodyPath := filepath.Join(state.directory, "repository-custody.key")
	if err := exclusiveWrite(custodyPath, custody, 0600); err != nil {
		return err
	}
	secrets = append(secrets, []string{"generic", "occ-repository-custody", "--from-file=custody.key=" + custodyPath})
	if inputs.preparedOrigin != "" {
		ca := map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": kubernetesMetadata("occ-repository-provider-ca", namespace, labels), "immutable": true, "data": map[string]string{"ca.crt": string(inputs.issuerCA)}}
		if err := r.writeAndApply(ctx, state, "repository-provider-ca", ca); err != nil {
			return err
		}
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
	// Native Git with worker-prepared GitHub custody; startup refuses the retired drivers.repo.
	prepared := map[string]any{
		"privateKeyPath": "/etc/openclaw/prepared-repository/private-key.pem",
		"custodyKeyPath": "/etc/openclaw/prepared-repository/custody.key",
	}
	if inputs.preparedOrigin != "" {
		prepared["issuerCaPath"], prepared["apiOrigin"] = preparedCA, inputs.preparedOrigin
	}
	installation["repository"] = map[string]any{
		"id":             "repository-credentials",
		"configuration":  map[string]any{"sessionDurationSeconds": inputs.registry["maximumDurationSeconds"]},
		"nativeSender":   map[string]any{"controlSocket": "/run/openclaw/repository-control/private/control.sock", "publicCaPath": "/etc/openclaw/repository-ca/ca.crt"},
		"preparedGitHub": prepared,
	}
	// Keep the installed Compute and model backend selection unchanged.
	backends, _ := installation["backend"].([]any)
	installation["backend"] = append(backends, map[string]any{"id": inputs.backendID, "type": "github", "configuration": map[string]any{"registryPath": "/etc/openclaw/repository-registry/registry.json"}, "drivers": map[string]string{"repo": "repository-credentials"}})
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
	repositoryValues := map[string]any{"enabled": true, "authority": "prepared-git", "preparedCustodySecretName": "occ-repository-custody", "image": image, "serviceName": "git", "backendId": inputs.backendID, "registryConfigMapName": "occ-repository-registry-v1", "serviceConfigSecretName": "occ-repository-service", "appKeySecretName": "occ-repository-app", "tlsSecretName": "occ-repository-tls", "publicCaSecretName": "occ-repository-ca", "upstreamCidrs": inputs.upstreamCIDRs}
	if inputs.preparedOrigin != "" {
		repositoryValues["upstreamPort"] = inputs.preparedPort
		repositoryValues["preparedProviderCaConfigMapName"] = "occ-repository-provider-ca"
	}
	values["repositoryCredentials"] = repositoryValues
	valuesData, err = json.Marshal(values)
	if err != nil {
		return err
	}
	if err := replaceDevelopmentFile(valuesPath, valuesData); err != nil {
		return err
	}
	if err := r.helmUpgrade(ctx, state, valuesPath, timeout); err != nil {
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
