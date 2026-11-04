package occdev

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"io"
	"strings"
	"time"
)

// k3dDirectImportAttempts bounds how often a direct archive import is tried
// when k3d loses its stream into the node.
const k3dDirectImportAttempts = 3

const k3dImportOutputLimit = 64 << 10

// stageDevelopmentPlatformChild reports whether it retagged the image for export.
// Docker's containerd store can save an incomplete archive for a manifest list,
// or refuse a platform-filtered save when the child blobs are missing. Tagging
// the platform child directly lets the importer save one complete image.
// If the child is unavailable, the caller can still export the original source.
func (r *runner) stageDevelopmentPlatformChild(ctx context.Context, source, platform, stagingTag string) (bool, error) {
	if !strings.Contains(source, "@") {
		return false, nil
	}
	child, err := r.developmentPlatformChild(ctx, source, platform)
	if err != nil || child == "" {
		// A locally selected candidate image has no registry listing, and its
		// reference already names one image.
		return false, nil
	}
	name, _, _ := strings.Cut(source, "@")
	resolved := name + "@" + child
	if _, err := r.output(ctx, r.engine, "image", "inspect", resolved); err != nil {
		if err := r.run(ctx, r.engine, "pull", resolved); err != nil {
			// The cached source can still export on stores that keep it
			// complete, so a failed child pull must not abort the import.
			fmt.Fprintf(r.opts.Out, "Could not pull the platform child of %s; saving the pinned reference instead.\n", name)
			return false, nil
		}
	}
	if resolved == source {
		return false, nil
	}
	if err := r.run(ctx, r.engine, "tag", resolved, stagingTag); err != nil {
		return false, err
	}
	return true, nil
}

// developmentPlatformChild names the manifest-list child the registry serves
// for one platform, through buildx when the engine is Docker (whose own
// `manifest inspect` can fail verification for the same lists) and through the
// engine's manifest listing otherwise.
// manifestPlatform describes one child of a registry manifest list.
type manifestPlatform struct {
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
}

// manifestPlatformChild names the child one registry listing serves for one
// platform. Docker's `manifest inspect --verbose` prints an array of
// Descriptor objects, Podman's prints the bare OCI index, and buildx wraps
// that index under "manifest"; every shape names children by digest and
// platform. A single-manifest reference lists no separate child.
func manifestPlatformChild(data []byte, platform string) string {
	var descriptors []struct {
		Descriptor struct {
			Digest   string           `json:"digest"`
			Platform manifestPlatform `json:"platform"`
		} `json:"Descriptor"`
	}
	if json.Unmarshal(data, &descriptors) == nil {
		for _, child := range descriptors {
			if child.Descriptor.Digest != "" &&
				child.Descriptor.Platform.OS+"/"+child.Descriptor.Platform.Architecture == platform {
				return child.Descriptor.Digest
			}
		}
		return ""
	}
	var index struct {
		Manifests []struct {
			Digest   string           `json:"digest"`
			Platform manifestPlatform `json:"platform"`
		} `json:"manifests"`
		Manifest struct {
			Manifests []struct {
				Digest   string           `json:"digest"`
				Platform manifestPlatform `json:"platform"`
			} `json:"manifests"`
		} `json:"manifest"`
	}
	if json.Unmarshal(data, &index) != nil {
		return ""
	}
	children := index.Manifests
	if len(children) == 0 {
		children = index.Manifest.Manifests
	}
	for _, child := range children {
		if child.Digest != "" &&
			child.Platform.OS+"/"+child.Platform.Architecture == platform {
			return child.Digest
		}
	}
	return ""
}

// developmentPlatformChild names the manifest-list child the registry serves
// for one platform, through buildx when the engine is Docker (whose own
// `manifest inspect` can fail verification for the same lists) and through the
// engine's manifest listing otherwise.
func (r *runner) developmentPlatformChild(ctx context.Context, source, platform string) (string, error) {
	if r.engine == "docker" {
		data, err := r.output(ctx, r.engine, "buildx", "imagetools", "inspect", "--format", "{{json .}}", source)
		if err == nil {
			// A successfully parsed listing without a matching child names none.
			return manifestPlatformChild(data, platform), nil
		}
	}
	data, err := r.output(ctx, r.engine, "manifest", "inspect", "--verbose", source)
	if err != nil {
		return "", err
	}
	return manifestPlatformChild(data, platform), nil
}

// importArchiveDirect streams an image archive into the cluster nodes with
// `k3d image import --mode direct`.
//
// k3d pipes the archive into `ctr image import -` over a Docker exec and
// inspects that exec right after attaching. Docker answers the attach before
// it marks the exec running, so k3d can read a not-yet-started exec as exited
// with code 0, close the connection, and report "failed to copy read stream.
// io: read/write on closed pipe" before ctr has read anything.
// Importing the same archive again is safe, so only that failure is retried, a
// bounded number of times; any other failure is returned at once.
func (r *runner) importArchiveDirect(ctx context.Context, archive, cluster string) error {
	for attempt := 1; ; attempt++ {
		output := &tailBuffer{limit: k3dImportOutputLimit}
		cmd := r.command(ctx, "k3d", "image", "import", "--mode", "direct", archive, "-c", cluster)
		cmd.Stdout = r.opts.Out
		cmd.Stderr = io.MultiWriter(r.opts.Err, output)
		started := time.Now()
		err := cmd.Run()
		r.commandTiming("k3d", []string{"image", "import"}, started, err)
		if err == nil {
			return nil
		}
		if attempt >= k3dDirectImportAttempts || ctx.Err() != nil || !k3dImportStreamClosed(string(output.Bytes())) {
			return fmt.Errorf("k3d failed: %w", err)
		}
		fmt.Fprintf(r.opts.Out, "k3d image import lost its stream into the node; retrying (attempt %d of %d)...\n", attempt+1, k3dDirectImportAttempts)
	}
}

// k3dImportStreamClosed reports whether k3d failed because it closed its own
// stream into the node: its stdin copy hit the connection k3d had closed ("use
// of closed network connection"), so the archive copy failed on the closed
// pipe. When ctr itself fails, the node closes the stream instead and the copy
// sees a broken pipe or reset, which is not retried.
func k3dImportStreamClosed(stderr string) bool {
	stderr = strings.ToLower(stderr)
	return strings.Contains(stderr, "failed to copy read stream") &&
		strings.Contains(stderr, "use of closed network connection") &&
		strings.Contains(stderr, "read/write on closed pipe")
}
