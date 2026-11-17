package occdev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strconv"
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
	OS           *string  `json:"Os"`
	Architecture *string  `json:"Architecture"`
	Descriptor   *struct {
		MediaType   string            `json:"mediaType"`
		Digest      string            `json:"digest"`
		Annotations map[string]string `json:"annotations"`
		Platform    *struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
		} `json:"platform"`
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
	// Own the pipes so a nonzero child exit cannot hide an incomplete drain.
	// Cmd.WaitDelay otherwise preserves ExitError even when it closes pipes.
	completed := make(chan error, 2)
	var readers, writers []*os.File
	defer func() {
		for _, pipe := range append(readers, writers...) {
			_ = pipe.Close()
		}
	}()
	for _, output := range []*tailBuffer{stdout, stderr} {
		reader, writer, err := os.Pipe()
		if err != nil {
			return nil, false, err
		}
		readers, writers = append(readers, reader), append(writers, writer)
		go func() {
			_, err := io.Copy(output, reader)
			completed <- err
		}()
	}
	cmd.Stdout, cmd.Stderr = writers[0], writers[1]
	started := time.Now()
	err := cmd.Run()
	for _, writer := range writers {
		_ = writer.Close()
	}
	drain := time.NewTimer(200 * time.Millisecond)
	defer drain.Stop()
	complete := true
	for range 2 {
		select {
		case readErr := <-completed:
			complete = complete && readErr == nil
		case <-drain.C:
			complete = false
			for _, reader := range readers {
				_ = reader.Close()
			}
			<-completed
		}
	}
	r.commandTiming(r.engine, args, started, err)
	if ctx.Err() != nil {
		return nil, false, ctx.Err()
	}
	if !complete || len(stdout.Bytes()) >= 4<<20 || len(stderr.Bytes()) >= 64<<10 {
		return nil, false, fmt.Errorf("image operation output was incomplete or exceeded its limit")
	}
	if err != nil {
		var exited *exec.ExitError
		diagnostic := strings.TrimSpace(string(stderr.Bytes()))
		output := strings.TrimSpace(string(stdout.Bytes()))
		reference := args[len(args)-1]
		query := reference
		if _, digest, pinned := strings.Cut(reference, "@"); pinned {
			reference = imageRepository(reference) + "@" + digest
		}
		// Match the complete engine result for this exact object. In particular,
		// a connection diagnostic quoting an absent object is not absence.
		absent := errors.As(err, &exited) && exited.ExitCode() == 1 &&
			(output == "" || output == "[]") &&
			(diagnostic == "Error response from daemon: No such image: "+reference ||
				diagnostic == "Error response from daemon: No such image: "+query ||
				diagnostic == "Error: "+reference+": image not known")
		if exited != nil && output == "" {
			exited.Stderr = append([]byte(nil), stderr.Bytes()...)
		}
		return nil, absent, fmt.Errorf("%s image operation failed: %w", r.engine, err)
	}
	return stdout.Bytes(), false, nil
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
		native := held
		if held.Descriptor != nil {
			native, err = r.inspectLocalImage(ctx, reference, selected.platform)
			if err != nil || native == nil {
				return "", false, err
			}
			if native.Descriptor == nil {
				return "", false, fmt.Errorf("native image inspection lost its descriptor")
			}
		}
		if native.OS == nil || native.Architecture == nil {
			return "", false, fmt.Errorf("local image has no explicit native platform")
		}
		if native.Descriptor != nil {
			if (native.Descriptor.MediaType != "application/vnd.oci.image.manifest.v1+json" && native.Descriptor.MediaType != "application/vnd.docker.distribution.manifest.v2+json") || native.Descriptor.Digest != child || native.ID != child {
				return "", false, fmt.Errorf("local image does not match the selected native manifest")
			}
			if config, present := native.Descriptor.Annotations["config.digest"]; present && config != selected.configDigest {
				return "", false, fmt.Errorf("local image descriptor contradicts its native config")
			}
			if platform := native.Descriptor.Platform; platform != nil && platform.OS+"/"+platform.Architecture != selected.platform {
				return "", false, fmt.Errorf("local image descriptor contradicts its native platform")
			}
			// Docker can list a known descriptor with explicit empty platform
			// strings when the native config is not loaded.
			if r.engine == "docker" && *native.OS == "" && *native.Architecture == "" {
				return "", false, nil
			}
		} else if native.ID != selected.configDigest {
			return "", false, fmt.Errorf("local image does not match the selected native config")
		}
		if *native.OS+"/"+*native.Architecture != selected.platform {
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
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
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
		if _, _, err := r.imageCommand(ctx, "image", "rm", record.Name); err != nil {
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
		data, _, err := r.imageCommand(ctx, "exec", server, "crictl", "inspecti", reference)
		if missingCRIImage(err, reference) && time.Now().Before(deadline) {
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

// CRI can lag behind a successful containerd import. This read-only retry must
// never authorize host tag acquisition or release a persisted custody record.
func missingCRIImage(err error, reference string) bool {
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 1 {
		return false
	}
	diagnostic := strings.TrimSpace(string(exited.Stderr))
	if !strings.HasPrefix(diagnostic, `time="`) {
		return false
	}
	timestamp, message, ok := strings.Cut(strings.TrimPrefix(diagnostic, `time="`), `" level=fatal msg=`)
	if !ok || strings.ContainsAny(timestamp, "\"\r\n") {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, timestamp); err != nil {
		return false
	}
	return message == strconv.Quote("no such image "+strconv.Quote(reference)+" present")
}
