package occdev

import (
	"context"
	"errors"
	"fmt"
	"os"
)

const nodeImportDiagnosticLimit = 64 << 10

// importImageIntoNode streams one image from the container engine straight
// into containerd on the owned k3d node, with no archive on disk:
// `<engine> image save` writes into `<engine> exec -i <node> ctr images import -`.
//
// Docker selects the image's Linux platform explicitly, as for every
// development image: tag-based k3d imports could report success without
// registering a local build in the node. The ctr command is the one k3d's
// direct import runs; the engine's exec, unlike k3d's own stream, waits for
// ctr to start and reports its exit status. The caller verifies the imported
// digest in containerd afterwards.
func (r *runner) importImageIntoNode(ctx context.Context, cluster, image, platform string) error {
	saveArgs := []string{"image", "save"}
	if r.engine == "docker" {
		saveArgs = append(saveArgs, "--platform", platform)
	}
	save := r.command(ctx, r.engine, append(saveArgs, image)...)
	load := r.command(ctx, r.engine, "exec", "-i", "k3d-"+cluster+"-server-0", "ctr", "-n", "k8s.io", "images", "import", "--all-platforms", "-")
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	// The two commands run at once, and the caller's writer need not be safe
	// for concurrent use, so the save's diagnostics follow once it has exited.
	saveDiagnostics := &tailBuffer{limit: nodeImportDiagnosticLimit}
	save.Stdout, save.Stderr = writer, saveDiagnostics
	load.Stdin, load.Stdout, load.Stderr = reader, r.opts.Out, r.opts.Err
	saveErr := save.Start()
	// Each process holds its own end now. Closing ours lets ctr see the end of
	// the stream when the save exits, and the save fail rather than block when
	// ctr exits early.
	writer.Close()
	var loadErr error
	if saveErr == nil {
		loadErr = load.Start()
	}
	reader.Close()
	if saveErr != nil {
		return fmt.Errorf("%s image save failed: %w", r.engine, saveErr)
	}
	if loadErr == nil {
		loadErr = load.Wait()
	}
	saveErr = save.Wait()
	_, _ = r.opts.Err.Write(saveDiagnostics.Bytes())
	// When ctr exits first, the save fails on the closed stream too; report both
	// rather than guess which one caused the other.
	var errs []error
	if saveErr != nil {
		errs = append(errs, fmt.Errorf("%s image save failed: %w", r.engine, saveErr))
	}
	if loadErr != nil {
		errs = append(errs, fmt.Errorf("node image import failed: %w", loadErr))
	}
	return errors.Join(errs...)
}
