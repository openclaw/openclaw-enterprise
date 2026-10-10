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
	// Create without starting either reader, and inspect their actual images and
	// Compose user overrides rather than assuming the image's default UID.
	if err := r.compose(ctx, state, "create", "--build", "--no-deps", "controller", "worker-kubernetes"); err != nil {
		return err
	}
	var owner [2]int
	var readerImage string
	for index, service := range []string{"controller", "worker-kubernetes"} {
		id, err := r.composeOutput(ctx, state, "ps", "--all", "-q", service)
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
		var container struct{ Image, User string }
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
		} else if current != owner {
			return fmt.Errorf("controller and worker-kubernetes must share a routing file owner")
		}
	}
	args := []string{"run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges"}
	for _, name := range []string{"gateway-api-key", "gateway-ca.crt"} {
		args = append(args, "--mount", "type=bind,source="+filepath.Join(state.directory, name)+",target=/routing/"+name)
	}
	args = append(args, "--entrypoint", "node", readerImage, "-e",
		`const fs=require('fs'); for (const name of ['gateway-api-key','gateway-ca.crt']) { const path='/routing/'+name; const stat=fs.lstatSync(path); if (!stat.isFile() || (stat.mode&0o777)!==0o600) throw new Error('Routing files must be private regular files'); fs.chownSync(path, Number(process.argv[1]), Number(process.argv[2])); }`,
		strconv.Itoa(owner[0]), strconv.Itoa(owner[1]))
	return r.run(ctx, r.engine, args...)
}
