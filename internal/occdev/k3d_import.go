package occdev

import (
	"archive/tar"
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"
)

// k3dDirectImportAttempts bounds how often a direct archive import is tried
// when k3d loses its stream into the node.
const k3dDirectImportAttempts = 3

const k3dImportOutputLimit = 64 << 10

// Docker's containerd store can save an incomplete manifest-list archive.
// Export its platform child directly when available, retaining the pinned
// source if the local store cannot obtain that child.
func (r *runner) resolveDevelopmentPlatformChild(ctx context.Context, source, platform string) (string, error) {
	if !strings.Contains(source, "@") {
		return source, nil
	}
	child, err := r.developmentPlatformChild(ctx, source, platform)
	if err != nil || child == "" {
		// A locally selected candidate image has no registry listing, and its
		// reference already names one image.
		return source, nil
	}
	name, _, _ := strings.Cut(source, "@")
	resolved := name + "@" + child
	if _, err := r.output(ctx, r.engine, "image", "inspect", resolved); err != nil {
		if err := r.run(ctx, r.engine, "pull", resolved); err != nil {
			// The cached source can still export on stores that keep it
			// complete, so a failed child pull must not abort the import.
			fmt.Fprintf(r.opts.Out, "Could not pull the platform child of %s; saving the pinned reference instead.\n", name)
			return source, nil
		}
	}
	if resolved == source {
		return source, nil
	}
	return resolved, nil
}

const developmentArchiveManifestLimit = 20 << 20

type developmentArchiveEntry struct {
	kind byte
	link string
}

// prepareDevelopmentImageArchive assigns one import name without touching the
// daemon's mutable tags. Docker's containerd-backed exporter can include both
// Docker and OCI metadata; containerd prefers OCI when oci-layout is present.
// Emit only the Docker representation so manifest.json owns the imported name.
// The config and layer contents remain unchanged.
func prepareDevelopmentImageArchive(ctx context.Context, source, destination, name string) (resultErr error) {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, input.Close()) }()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	writer := tar.NewWriter(output)
	defer func() { resultErr = errors.Join(resultErr, writer.Close(), output.Close()) }()
	reader := tar.NewReader(input)
	entries := make(map[string]developmentArchiveEntry)
	var required []string
	foundManifest := false
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if header.Typeflag == tar.TypeDir && path.Clean(header.Name) == "." {
			continue
		}
		entryName, err := developmentArchivePath(header.Name)
		if err != nil {
			return err
		}
		if previous, exists := entries[entryName]; exists {
			if header.Typeflag == tar.TypeDir && previous.kind == tar.TypeDir {
				continue
			}
			return fmt.Errorf("duplicate image archive entry %q", entryName)
		}
		entry := developmentArchiveEntry{kind: header.Typeflag}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeRegA, tar.TypeDir:
		case tar.TypeSymlink:
			if path.IsAbs(header.Linkname) {
				return fmt.Errorf("absolute image archive link %q", entryName)
			}
			entry.link, err = developmentArchivePath(path.Join(path.Dir(entryName), header.Linkname))
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported image archive entry %q", entryName)
		}
		entries[entryName] = entry
		header.Name = entryName
		if entryName == "oci-layout" || entryName == "index.json" || entryName == "repositories" {
			continue
		}
		if entryName == "manifest.json" {
			if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA || header.Size > developmentArchiveManifestLimit {
				return fmt.Errorf("invalid Docker image archive manifest")
			}
			data, err := io.ReadAll(reader)
			if err != nil {
				return err
			}
			var manifests []map[string]jsontext.Value
			if err := json.Unmarshal(data, &manifests); err != nil || len(manifests) != 1 || manifests[0] == nil {
				return fmt.Errorf("image archive must contain exactly one Docker manifest")
			}
			var config string
			var layers []string
			if json.Unmarshal(manifests[0]["Config"], &config) != nil || config == "" || json.Unmarshal(manifests[0]["Layers"], &layers) != nil {
				return fmt.Errorf("invalid Docker image archive manifest")
			}
			required = append([]string{config}, layers...)
			tags, err := json.Marshal([]string{name})
			if err != nil {
				return err
			}
			manifests[0]["RepoTags"] = tags
			data, err = json.Marshal(manifests)
			if err != nil {
				return err
			}
			header.Size = int64(len(data))
			if err := writer.WriteHeader(header); err != nil {
				return err
			}
			if _, err := writer.Write(data); err != nil {
				return err
			}
			foundManifest = true
			continue
		}
		if err := writer.WriteHeader(header); err != nil {
			return err
		}
		if _, err := io.Copy(writer, reader); err != nil {
			return err
		}
	}
	if !foundManifest {
		return fmt.Errorf("image archive has no Docker manifest")
	}
	for _, requiredName := range required {
		clean, err := developmentArchivePath(requiredName)
		if err != nil || clean != requiredName {
			return fmt.Errorf("invalid image archive content path %q", requiredName)
		}
		if clean == "manifest.json" || clean == "oci-layout" || clean == "index.json" || clean == "repositories" {
			return fmt.Errorf("image archive content %q is missing or invalid", requiredName)
		}
		entry, exists := entries[clean]
		if exists && entry.kind == tar.TypeSymlink {
			clean = entry.link
			entry, exists = entries[entry.link]
		}
		if !exists || (entry.kind != tar.TypeReg && entry.kind != tar.TypeRegA) || clean == "manifest.json" || clean == "oci-layout" || clean == "index.json" || clean == "repositories" {
			return fmt.Errorf("image archive content %q is missing or invalid", requiredName)
		}
	}
	return nil
}

func developmentArchivePath(name string) (string, error) {
	clean := path.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) {
		return "", fmt.Errorf("invalid image archive path %q", name)
	}
	return clean, nil
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
