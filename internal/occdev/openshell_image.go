package occdev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// nativeImageSelection binds a caller's immutable source to the owned node.
// cacheIndex is an alternate local lookup, never an alternate pull target.
type nativeImageSelection struct {
	platform     string
	configDigest string
	cacheIndex   string
}

type localImage struct {
	ID           string   `json:"Id"`
	RepoDigests  []string `json:"RepoDigests"`
	OS           string   `json:"Os"`
	Architecture string   `json:"Architecture"`
	Descriptor   *struct {
		MediaType string `json:"mediaType"`
		Digest    string `json:"digest"`
	} `json:"Descriptor"`
}

// Keep absence classification local to image inspection; arbitrary command
// output must neither authorize a mutation nor enter an operator diagnostic.
func (r *runner) imageCommand(ctx context.Context, args ...string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	stdout := &tailBuffer{limit: 4 << 20}
	stderr := &tailBuffer{limit: 64 << 10}
	cmd := r.command(ctx, r.engine, args...)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	started := time.Now()
	err := cmd.Run()
	r.commandTiming(r.engine, args, started, err)
	if ctx.Err() != nil {
		return nil, false, ctx.Err()
	}
	if err != nil {
		text := strings.ToLower(string(stderr.Bytes()))
		absent := strings.Contains(text, "no such image") || strings.Contains(text, "no such object") || strings.Contains(text, "image not known")
		return nil, absent, fmt.Errorf("%s image operation failed: %w", r.engine, err)
	}
	data := stdout.Bytes()
	if len(data) >= 4<<20 {
		return nil, false, fmt.Errorf("image operation output exceeded its limit")
	}
	return data, false, nil
}

func (r *runner) inspectLocalImage(ctx context.Context, reference, platform string) (*localImage, error) {
	args := []string{"image", "inspect"}
	if platform != "" && r.engine == "docker" {
		args = append(args, "--platform", platform)
	}
	data, absent, err := r.imageCommand(ctx, append(args, reference)...)
	if absent {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var images []localImage
	if json.Unmarshal(data, &images) != nil || len(images) != 1 {
		return nil, fmt.Errorf("invalid local image inspection for %s", reference)
	}
	image := images[0]
	if len(image.ID) == 64 {
		image.ID = "sha256:" + image.ID
	}
	if !imageDigest.MatchString(image.ID) {
		return nil, fmt.Errorf("invalid local image identity for %s", reference)
	}
	return &image, nil
}

func imageRepository(reference string) string {
	name, _, _ := strings.Cut(reference, "@")
	if strings.LastIndex(name, ":") > strings.LastIndex(name, "/") {
		name = name[:strings.LastIndex(name, ":")]
	}
	return name
}

func (r *runner) selectNativeImage(ctx context.Context, source string, selected *nativeImageSelection, localOnly bool) (string, string, error) {
	_, child, _ := strings.Cut(source, "@")
	_, index, _ := strings.Cut(selected.cacheIndex, "@")
	if !imageDigest.MatchString(child) || !imageDigest.MatchString(index) || !imageDigest.MatchString(selected.configDigest) || imageRepository(source) != imageRepository(selected.cacheIndex) || !strings.HasPrefix(selected.platform, "linux/") {
		return "", "", fmt.Errorf("invalid native image selection")
	}
	inspect := func(reference string) (string, bool, error) {
		held, err := r.inspectLocalImage(ctx, reference, "")
		if err != nil || held == nil {
			return "", false, err
		}
		_, digest, _ := strings.Cut(reference, "@")
		if !slices.Contains(held.RepoDigests, imageRepository(reference)+"@"+digest) {
			return "", false, fmt.Errorf("local image does not match the exact repository digest: %s", reference)
		}
		if held.Descriptor != nil && (held.Descriptor.Digest != digest || held.ID != held.Descriptor.Digest) {
			return "", false, fmt.Errorf("local image descriptor contradicts its acquisition identity")
		}
		native, err := r.inspectLocalImage(ctx, reference, selected.platform)
		if err != nil || native == nil {
			return "", false, err
		}
		if native.Descriptor != nil {
			if (native.Descriptor.MediaType != "application/vnd.oci.image.manifest.v1+json" && native.Descriptor.MediaType != "application/vnd.docker.distribution.manifest.v2+json") || native.Descriptor.Digest != child {
				return "", false, fmt.Errorf("local image does not match the selected native manifest")
			}
			// Docker can list a known descriptor with no loaded native config.
			if r.engine == "docker" && native.OS == "" && native.Architecture == "" {
				return "", false, nil
			}
		} else if native.ID != selected.configDigest {
			return "", false, fmt.Errorf("local image does not match the selected native config")
		}
		if native.OS+"/"+native.Architecture != selected.platform {
			return "", false, fmt.Errorf("local image does not match the selected node platform")
		}
		return held.ID, true, nil
	}
	for _, reference := range []string{source, selected.cacheIndex} {
		id, available, err := inspect(reference)
		if err != nil {
			return "", "", err
		}
		if available {
			return reference, id, nil
		}
	}
	if localOnly {
		return "", "", fmt.Errorf("selected native image is not available locally")
	}
	if err := r.run(ctx, r.engine, "pull", source); err != nil {
		return "", "", err
	}
	id, available, err := inspect(source)
	if err != nil {
		return "", "", err
	}
	if !available {
		return "", "", fmt.Errorf("pull did not materialize the selected native image")
	}
	return source, id, nil
}

type openShellImageTag struct {
	Name    string `json:"name"`
	ImageID string `json:"imageId"`
}

func validOpenShellImageTag(tag *openShellImageTag, cluster string) bool {
	if tag == nil {
		return true
	}
	for _, component := range []string{"agent-sandbox-controller", "gateway", "sandbox", "supervisor"} {
		if tag.Name == "openclaw-development/openshell-"+component+":"+cluster {
			return imageDigest.MatchString(tag.ImageID)
		}
	}
	return false
}

func (r *runner) stageOpenShellImage(ctx context.Context, state *developmentState, source, tag, id string) error {
	record := &openShellImageTag{Name: tag, ImageID: id}
	if state.OpenShellImageTag != nil || !validOpenShellImageTag(record, state.Cluster) {
		return fmt.Errorf("OpenShell staging image has unresolved or invalid custody")
	}
	held, err := r.inspectLocalImage(ctx, tag, "")
	if err != nil {
		return err
	}
	if held != nil {
		return fmt.Errorf("OpenShell development staging image already exists: %s", tag)
	}
	state.OpenShellImageTag = record
	if err := rewriteState(state); err != nil {
		state.OpenShellImageTag = nil
		return err
	}
	return r.run(ctx, r.engine, "tag", source, tag)
}

func (r *runner) reconcileOpenShellImageTag(ctx context.Context, state *developmentState) error {
	record := state.OpenShellImageTag
	if record == nil {
		return nil
	}
	if !validOpenShellImageTag(record, state.Cluster) {
		return fmt.Errorf("invalid OpenShell staging image custody")
	}
	held, err := r.inspectLocalImage(ctx, record.Name, "")
	if err != nil {
		return err
	}
	if held != nil {
		if held.ID != record.ImageID {
			return fmt.Errorf("OpenShell staging image %s was replaced; preserving it and recovery state", record.Name)
		}
		if err := r.run(ctx, r.engine, "image", "rm", record.Name); err != nil {
			return err
		}
		held, err = r.inspectLocalImage(ctx, record.Name, "")
		if err != nil {
			return err
		}
		if held != nil {
			return fmt.Errorf("OpenShell staging image %s remains after removal", record.Name)
		}
	}
	state.OpenShellImageTag = nil
	if err := rewriteState(state); err != nil {
		state.OpenShellImageTag = record
		return err
	}
	return nil
}

func (r *runner) verifyNativeImportedImage(ctx context.Context, server, reference, config string) error {
	_, digest, _ := strings.Cut(reference, "@")
	data, _, err := r.imageCommand(ctx, "exec", server, "ctr", "-n", "k8s.io", "content", "get", digest)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	var manifest struct {
		Config struct {
			Digest string `json:"digest"`
		} `json:"config"`
	}
	if "sha256:"+hex.EncodeToString(sum[:]) != digest || json.Unmarshal(data, &manifest) != nil || manifest.Config.Digest != config {
		return fmt.Errorf("imported native manifest does not match the selected config")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, absent, err := r.imageCommand(ctx, "exec", server, "crictl", "inspecti", reference)
		if absent && time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
				continue
			}
		}
		if err != nil {
			return err
		}
		var image struct {
			Status struct {
				ID          string   `json:"id"`
				RepoDigests []string `json:"repoDigests"`
			} `json:"status"`
		}
		if json.Unmarshal(data, &image) != nil || image.Status.ID != config || !slices.Contains(image.Status.RepoDigests, reference) {
			return fmt.Errorf("imported CRI image does not match the selected native config")
		}
		return nil
	}
}

func (r *runner) finishOpenShellImage(ctx context.Context, state *developmentState, result *error) {
	if err := r.reconcileOpenShellImageTag(context.WithoutCancel(ctx), state); err != nil {
		*result = errors.Join(*result, fmt.Errorf("remove OpenShell staging image: %w", err))
	}
}
