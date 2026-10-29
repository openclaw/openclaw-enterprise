package occdev

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// prepareComposeRoutingFiles keeps routing material private when the host UID
// differs from the non-root users in the selected control-plane images.
func (r *runner) prepareComposeRoutingFiles(ctx context.Context, state *developmentState) error {
	// Create without starting the readers, and inspect their actual images and
	// Compose user overrides rather than assuming the image's default UID.
	readers := []string{"controller", "worker-kubernetes"}
	// Startup uses --no-build after ownership preparation, including for the browser endpoint.
	if state.BrowserPort != 0 {
		readers = append(readers, "browser-proxy")
	}
	if err := r.compose(ctx, state, append([]string{"build"}, readers...)...); err != nil {
		return err
	}
	args := append([]string{"up", "--no-start", "--no-build", "--no-deps"}, readers...)
	if err := r.compose(ctx, state, args...); err != nil {
		return err
	}
	var owner [2]int
	var readerImage string
	for index, service := range readers {
		id, err := r.composeServiceID(ctx, state, service)
		if err != nil {
			return err
		}
		if len(strings.Fields(string(id))) != 1 {
			return fmt.Errorf("expected one %s container for routing file ownership", service)
		}
		data, err := r.output(ctx, r.engine, "inspect", "--format", `{"image":{{json .Image}},"user":{{json .Config.User}}}`, string(id))
		if err != nil {
			return err
		}
		var container struct {
			Image string `json:"image"`
			User  string `json:"user"`
		}
		if err := json.Unmarshal(data, &container); err != nil || container.Image == "" {
			return fmt.Errorf("could not resolve %s routing reader image", service)
		}
		args := []string{"run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"}
		if container.User != "" {
			args = append(args, "--user", container.User)
		}
		args = append(args, "--entrypoint", "node", container.Image, "-p", "JSON.stringify([process.getuid(), process.getgid()])")
		data, err = r.output(ctx, r.engine, args...)
		if err != nil {
			return err
		}
		var identity []int
		if err := json.Unmarshal(data, &identity); err != nil || len(identity) != 2 || identity[0] <= 0 || identity[1] < 0 {
			return fmt.Errorf("%s must use a non-root routing file reader", service)
		}
		current := [2]int{identity[0], identity[1]}
		if index == 0 {
			owner, readerImage = current, container.Image
		} else if service == "worker-kubernetes" && current != owner {
			return fmt.Errorf("controller and worker-kubernetes must share a routing file owner")
		}
		if service == "browser-proxy" {
			if err := r.assignComposeFileOwner(ctx, state, container.Image, current, []string{"browser-tls.crt", "browser-tls.key"}); err != nil {
				return err
			}
		}
	}
	return r.assignComposeFileOwner(ctx, state, readerImage, owner, []string{"gateway-api-key", "gateway-ca.crt"})
}

func (r *runner) assignComposeFileOwner(ctx context.Context, state *developmentState, image string, owner [2]int, files []string) error {
	args := []string{"run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges"}
	for _, name := range files {
		// Relabel only these files for sharing with their eventual readers.
		args = append(args, "--volume", filepath.Join(state.directory, name)+":/routing/"+name+":rw,z")
	}
	args = append(args, "--entrypoint", "node", image, "-e",
		`const fs=require('fs'); for (const name of process.argv.slice(3)) { const path='/routing/'+name; const stat=fs.lstatSync(path); if (!stat.isFile() || (stat.mode&0o777)!==0o600) throw new Error('Mounted credentials must be private regular files'); fs.chownSync(path, Number(process.argv[1]), Number(process.argv[2])); }`,
		strconv.Itoa(owner[0]), strconv.Itoa(owner[1]))
	args = append(args, files...)
	return r.run(ctx, r.engine, args...)
}
