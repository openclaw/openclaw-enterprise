package occdev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// developmentImageRegistry is a local registry container, named by
// OCC_DEVELOPMENT_IMAGE_REGISTRY_CONTAINER, that already holds the selected
// images. The k3d node pulls images pinned to its loopback address by digest
// straight from it, so they skip the archive export and import. Without the
// setting every image takes the archive path.
type developmentImageRegistry struct {
	container string
	// ports maps each loopback host address the container publishes
	// ("127.0.0.1:5000") to the container port behind it ("5000").
	ports map[string]string

	mu sync.Mutex
	// network is set from the attach attempt until the container is detached
	// from the cluster network; address is the registry's IPv4 address there.
	network, address string
	// pending counts the selected images still to pull. The last pull
	// detaches the registry, so it is reachable from the cluster only while
	// images are pulled.
	pending int
}

var registryContainerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

const developmentImageRegistrySetting = "OCC_DEVELOPMENT_IMAGE_REGISTRY_CONTAINER"

// developmentImageRegistryDetachTimeout bounds the disconnect, which also runs
// on rollback after the caller's context ended.
const developmentImageRegistryDetachTimeout = time.Minute

// developmentRegistryImageSettings are the selections importDevelopmentImage
// may pull from the registry.
var developmentRegistryImageSettings = []string{"OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_DEVELOPMENT_POSTGRES_IMAGE", "OCC_DEVELOPMENT_REPOSITORY_IMAGE"}

// selectDevelopmentImageRegistry reads the optional registry container and
// checks it before the cluster exists: it must publish its ports on IPv4
// loopback only, and at least one selected image must be pinned by digest to
// one of those ports, or the setting would silently do nothing.
func (r *runner) selectDevelopmentImageRegistry(ctx context.Context) error {
	container := r.env[developmentImageRegistrySetting]
	if container == "" {
		return nil
	}
	if !registryContainerName.MatchString(container) {
		return fmt.Errorf("%s must name a container", developmentImageRegistrySetting)
	}
	data, err := r.output(ctx, r.engine, "container", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container)
	if err != nil {
		return fmt.Errorf("inspect the development image registry container %s: %w", container, err)
	}
	var published map[string][]struct {
		HostIP   string `json:"HostIp"`
		HostPort string `json:"HostPort"`
	}
	if err := json.Unmarshal(data, &published); err != nil {
		return fmt.Errorf("invalid port inventory for the development image registry container %s", container)
	}
	ports := map[string]string{}
	for containerPort, bindings := range published {
		port, protocol, _ := strings.Cut(containerPort, "/")
		for _, binding := range bindings {
			if binding.HostIP != "127.0.0.1" {
				return fmt.Errorf("the development image registry container %s must publish its ports on 127.0.0.1 only", container)
			}
			if protocol == "tcp" && validPort(port) && validPort(binding.HostPort) {
				ports[binding.HostIP+":"+binding.HostPort] = port
			}
		}
	}
	if len(ports) == 0 {
		return fmt.Errorf("the development image registry container %s publishes no TCP port on 127.0.0.1", container)
	}
	registry := &developmentImageRegistry{container: container, ports: ports}
	for _, key := range developmentRegistryImageSettings {
		if _, _, ok := registry.source(r.env[key]); ok {
			registry.pending++
		}
	}
	if registry.pending == 0 {
		return fmt.Errorf("%s is set, but no selected controller, runtime, PostgreSQL or repository image is pinned by digest to its published address", developmentImageRegistrySetting)
	}
	r.imageRegistry = registry
	return nil
}

func validPort(value string) bool {
	port, err := strconv.Atoi(value)
	return err == nil && port > 0 && port <= 65535 && strconv.Itoa(port) == value
}

// source reports the container port and repository path behind an image
// reference of the form 127.0.0.1:<published port>/<path>@sha256:<digest>.
// Tagged references, other registries and other forms take the archive path.
func (g *developmentImageRegistry) source(image string) (port, path string, ok bool) {
	if g == nil {
		return "", "", false
	}
	name, digest, found := strings.Cut(image, "@")
	if !found || !imageDigest.MatchString(digest) {
		return "", "", false
	}
	host, path, found := strings.Cut(name, "/")
	port, served := g.ports[host]
	if !found || !served || path == "" || strings.ContainsAny(path, ": \t\n\r@") {
		return "", "", false
	}
	return port, path, true
}

// developmentRegistryImage is what a registry-selected image's config says,
// read from the registry and verified against the selected digest.
type developmentRegistryImage struct {
	Platform string
	Labels   map[string]string
}

// developmentRegistryReadLimit bounds each manifest and config read.
const developmentRegistryReadLimit = 4 << 20

// developmentRegistryReadTimeout bounds each registry request.
const developmentRegistryReadTimeout = 30 * time.Second

var developmentRegistryClient = &http.Client{
	Timeout:   developmentRegistryReadTimeout,
	Transport: &http.Transport{Proxy: nil},
	// The registry serves its content itself; a redirect points elsewhere.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// readRegistryImage reads a registry-selected image's manifest and config from
// the registry's published loopback address, for an image the local engine
// does not hold. The manifest must hash to the selected digest and the config
// to the digest the manifest names, so the platform and labels returned belong
// to the image the node pulls; containerd verifies the same chain when it does.
// Image indexes are refused: the node pull would choose one entry itself.
func (r *runner) readRegistryImage(ctx context.Context, image string) (developmentRegistryImage, error) {
	if _, _, ok := r.imageRegistry.source(image); !ok {
		return developmentRegistryImage{}, fmt.Errorf("image is not pinned to the development image registry: %s", image)
	}
	name, digest, _ := strings.Cut(image, "@")
	host, path, _ := strings.Cut(name, "/")
	base := "http://" + host + "/v2/" + path
	data, err := readRegistryContent(ctx, base+"/manifests/"+digest, digest,
		"application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json")
	if err != nil {
		return developmentRegistryImage{}, fmt.Errorf("read %s from the development image registry: %w", image, err)
	}
	var manifest struct {
		MediaType string `json:"mediaType"`
		Config    struct {
			Digest string `json:"digest"`
		} `json:"config"`
		Manifests []any `json:"manifests"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil || manifest.Manifests != nil || !imageDigest.MatchString(manifest.Config.Digest) ||
		(manifest.MediaType != "" && manifest.MediaType != "application/vnd.oci.image.manifest.v1+json" && manifest.MediaType != "application/vnd.docker.distribution.manifest.v2+json") {
		return developmentRegistryImage{}, fmt.Errorf("the development image registry holds no single image manifest for %s", image)
	}
	data, err = readRegistryContent(ctx, base+"/blobs/"+manifest.Config.Digest, manifest.Config.Digest, "")
	if err != nil {
		return developmentRegistryImage{}, fmt.Errorf("read the config of %s from the development image registry: %w", image, err)
	}
	var config struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
		Config       struct {
			Labels map[string]string `json:"Labels"`
		} `json:"config"`
	}
	if err := json.Unmarshal(data, &config); err != nil || config.OS == "" || config.Architecture == "" ||
		strings.ContainsAny(config.OS+config.Architecture, "/ \t\n\r") {
		return developmentRegistryImage{}, fmt.Errorf("invalid image config for %s in the development image registry", image)
	}
	return developmentRegistryImage{Platform: config.OS + "/" + config.Architecture, Labels: config.Config.Labels}, nil
}

// readRegistryContent fetches one manifest or blob and checks it against the
// digest that names it.
func readRegistryContent(ctx context.Context, url, digest, accept string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, developmentRegistryReadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		request.Header.Set("Accept", accept)
	}
	response, err := developmentRegistryClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, developmentRegistryReadLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > developmentRegistryReadLimit {
		return nil, fmt.Errorf("content larger than %d bytes", developmentRegistryReadLimit)
	}
	sum := sha256.Sum256(data)
	if "sha256:"+hex.EncodeToString(sum[:]) != digest {
		return nil, errors.New("content does not match its digest " + digest)
	}
	return data, nil
}

// developmentImagePlatform reports a selected image's platform from the local
// engine, or else from the development image registry that serves it.
func (r *runner) developmentImagePlatform(ctx context.Context, image string) (string, error) {
	platform, err := r.output(ctx, r.engine, "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image)
	if err == nil {
		return string(platform), nil
	}
	if _, _, ok := r.imageRegistry.source(image); !ok {
		return "", err
	}
	selected, registryErr := r.readRegistryImage(ctx, image)
	if registryErr != nil {
		return "", errors.Join(err, registryErr)
	}
	return selected.Platform, nil
}

// registryNetworkAddress reports the registry container's address on a
// network, or "" when it is not connected to it.
func (r *runner) registryNetworkAddress(ctx context.Context, g *developmentImageRegistry, network string) (string, error) {
	data, err := r.output(ctx, r.engine, "container", "inspect", "--format", `{{with index .NetworkSettings.Networks "`+network+`"}}{{.IPAddress}}{{end}}`, g.container)
	if err != nil {
		return "", fmt.Errorf("read the development image registry address on %s: %w", network, err)
	}
	return string(data), nil
}

// attach connects the registry container to the cluster network, so the node
// can reach it. Nothing else changes: the registry stays published on loopback
// only, and detach removes it from the cluster network again. A connection
// left by an interrupted earlier start of the same cluster is reused.
func (r *runner) attachDevelopmentImageRegistry(ctx context.Context, state *developmentState) error {
	g := r.imageRegistry
	if g == nil {
		return nil
	}
	network := "k3d-" + state.Cluster
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.network != "" {
		return nil
	}
	// Recorded before connecting: a connect cut short by cancellation may
	// still have attached the container, and detach checks before it acts.
	g.network = network
	fmt.Fprintf(r.opts.Out, "Attaching the loopback image registry %s to the cluster network...\n", g.container)
	value, err := r.registryNetworkAddress(ctx, g, network)
	if err != nil {
		return err
	}
	if value == "" {
		if err := r.run(ctx, r.engine, "network", "connect", network, g.container); err != nil {
			return fmt.Errorf("attach the development image registry to %s: %w", network, err)
		}
		if value, err = r.registryNetworkAddress(ctx, g, network); err != nil {
			return err
		}
	}
	address, err := netip.ParseAddr(value)
	if err != nil || !address.Is4() {
		return fmt.Errorf("the development image registry has no IPv4 address on %s", network)
	}
	g.address = address.String()
	return nil
}

// detachDevelopmentImageRegistry disconnects the registry from the cluster
// network. It is safe to call more than once, after a failed attach, and after
// the caller's context ended (it then has its own deadline).
func (r *runner) detachDevelopmentImageRegistry(ctx context.Context) error {
	g := r.imageRegistry
	if g == nil {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return r.detachDevelopmentImageRegistryLocked(ctx, g)
}

func (r *runner) detachDevelopmentImageRegistryLocked(ctx context.Context, g *developmentImageRegistry) error {
	if g.network == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), developmentImageRegistryDetachTimeout)
	defer cancel()
	value, err := r.registryNetworkAddress(ctx, g, g.network)
	if err != nil {
		return fmt.Errorf("detach the development image registry from %s: %w", g.network, err)
	}
	if value != "" {
		if err := r.run(ctx, r.engine, "network", "disconnect", g.network, g.container); err != nil {
			return fmt.Errorf("detach the development image registry from %s: %w", g.network, err)
		}
	}
	g.network, g.address = "", ""
	return nil
}

// pullDevelopmentImage has the node's containerd pull a digest-pinned image
// from the attached registry, then names it exactly as selected. containerd
// verifies every manifest, config and layer it fetches against the digests
// that pin them, and the result is checked against the selected digest before
// it is used.
func (r *runner) pullDevelopmentImage(ctx context.Context, s *developmentState, image, port, path string) (string, error) {
	g := r.imageRegistry
	g.mu.Lock()
	address := g.address
	g.mu.Unlock()
	if address == "" {
		return "", fmt.Errorf("the development image registry is not attached to the cluster network")
	}
	// The local engine or the registry holds the same digest (its labels were
	// checked); keep the Linux platform requirement of the archive path.
	platform, err := r.developmentImagePlatform(ctx, image)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(platform, "linux/") {
		return "", fmt.Errorf("development image must contain a Linux platform: %s", image)
	}
	_, digest, _ := strings.Cut(image, "@")
	source := address + ":" + port + "/" + path + "@" + digest
	server := "k3d-" + s.Cluster + "-server-0"
	fmt.Fprintf(r.opts.Out, "Pulling %s into the cluster from the loopback image registry...\n", image)
	// ctr reports progress on stdout and failures on stderr.
	pull := r.command(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "pull", "--plain-http", "--platform", platform, source)
	pull.Stdout = io.Discard
	pull.Stderr = r.opts.Err
	if err := pull.Run(); err != nil {
		return "", fmt.Errorf("pull %s into the cluster: %w", image, err)
	}
	if err := r.run(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "tag", source, image); err != nil {
		return "", err
	}
	data, err := r.output(ctx, r.engine, "exec", server, "ctr", "-n", "k8s.io", "images", "list")
	if err != nil {
		return "", err
	}
	var found []string
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == image {
			found = append(found, fields[2])
		}
	}
	if len(found) != 1 || found[0] != digest {
		return "", errors.New("the pulled image does not match the selected digest: " + image)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pending--; g.pending <= 0 {
		if err := r.detachDevelopmentImageRegistryLocked(ctx, g); err != nil {
			return "", err
		}
	}
	return image, nil
}
