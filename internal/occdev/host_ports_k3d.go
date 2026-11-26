package occdev

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// developmentHostPort is a loopback host port a development start publishes
// and the setting that moves it.
type developmentHostPort struct {
	port    int
	setting string
}

// The default Docker-compatible stack's Compose project (compose.yaml) and
// the Compose control plane's project for Kubernetes Compute.
const (
	dockerDevelopmentComposeProject     = "openclaw-enterprise-development"
	kubernetesDevelopmentComposeProject = "openclaw-enterprise-development-kubernetes"
)

// developmentStack names the Compose project and k3d cluster of the stack a
// start creates, so the port preflight can tell that stack, already running,
// from another one. An empty field matches nothing.
type developmentStack struct {
	composeProject string
	cluster        string
}

// checkDevelopmentHostPorts refuses a start whose loopback host ports a
// container on the selected engine already publishes. k3d would otherwise
// fail several seconds later with only "port is already allocated" in its
// output; the likely holder is another development stack, or the one being
// started, so the message names the container and how to stop that stack.
// The probe is best effort: when the engine cannot list containers, k3d's own
// error still reports the clash. A process outside the engine is not
// detected here.
func (r *runner) checkDevelopmentHostPorts(ctx context.Context, starting developmentStack, ports []developmentHostPort) error {
	data, err := r.output(ctx, r.engine, "ps", "--format", "{{.Names}}\t{{.Ports}}\t{{.Labels}}")
	if err != nil {
		return nil
	}
	// Check the ports in the order given, so the most telling one (the API
	// port) is named first when a whole stack holds several.
	lines := strings.Split(string(data), "\n")
	for _, wanted := range ports {
		for _, line := range lines {
			fields := strings.SplitN(line, "\t", 3)
			if len(fields) < 2 {
				continue
			}
			name, published := strings.TrimSpace(fields[0]), fields[1]
			labels := ""
			if len(fields) == 3 {
				labels = fields[2]
			}
			if publishesLoopbackPort(published, wanted.port) {
				return developmentHostPortHeld(starting, wanted, name, labels)
			}
		}
	}
	return nil
}

// A published TCP port in `ps` output: "127.0.0.1:3000->3000/tcp",
// "0.0.0.0:3000-3001->3000-3001/tcp", "[::]:3000->3000/tcp". Entries without
// "->" are only exposed; UDP and SCTP publications never hold a TCP port.
var publishedPortEntry = regexp.MustCompile(`^(?:(.*):)?(\d+)(?:-(\d+))?->\d+(?:-\d+)?/tcp$`)

// publishesLoopbackPort reports whether a container's published TCP ports
// bind port on an address that overlaps 127.0.0.1.
func publishesLoopbackPort(published string, port int) bool {
	for _, entry := range strings.Split(published, ",") {
		match := publishedPortEntry.FindStringSubmatch(strings.TrimSpace(entry))
		if match == nil {
			continue
		}
		host := strings.Trim(match[1], "[]")
		if host != "" && host != "0.0.0.0" && host != "::" && !strings.HasPrefix(host, "127.") {
			continue
		}
		first, err := strconv.Atoi(match[2])
		if err != nil {
			continue
		}
		last := first
		if match[3] != "" {
			if last, err = strconv.Atoi(match[3]); err != nil {
				continue
			}
		}
		if first <= port && port <= last {
			return true
		}
	}
	return false
}

// containerLabel reads one label from `ps --format {{.Labels}}` output:
// Docker prints "k=v,k=v", Podman "map[k:v k:v]".
func containerLabel(labels, key string) (string, bool) {
	if strings.HasPrefix(labels, "map[") {
		for _, item := range strings.Fields(strings.TrimSuffix(strings.TrimPrefix(labels, "map["), "]")) {
			if value, ok := strings.CutPrefix(item, key+":"); ok {
				return value, true
			}
		}
		return "", false
	}
	for _, item := range strings.Split(labels, ",") {
		if value, ok := strings.CutPrefix(item, key+"="); ok {
			return value, true
		}
	}
	return "", false
}

func developmentHostPortHeld(starting developmentStack, wanted developmentHostPort, container, labels string) error {
	prefix := fmt.Sprintf("host port 127.0.0.1:%d (%s) is already published by container %s", wanted.port, wanted.setting, container)
	move := fmt.Sprintf("or set %s to a free port", wanted.setting)
	// The stack being started is already running: another port would only start
	// a second copy of the same Compose project or cluster, so stopping it is the fix.
	if cluster, ok := containerLabel(labels, "k3d.cluster"); ok && cluster == starting.cluster {
		return fmt.Errorf("%s: the Kubernetes development stack being started (k3d cluster %s) is already running; stop it with occ dev down using the state directory it printed, then start it again", prefix, cluster)
	}
	if project, ok := containerLabel(labels, "com.docker.compose.project"); ok && project == starting.composeProject {
		return fmt.Errorf("%s: the Compose control plane being started (Compose project %s) is already running; stop it with OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes occ dev down, then start it again", prefix, project)
	}
	if cluster, ok := containerLabel(labels, "k3d.cluster"); ok {
		return fmt.Errorf("%s: another Kubernetes development stack (k3d cluster %s) may be running; stop it with occ dev down using the state directory it printed, %s", prefix, cluster, move)
	}
	if project, ok := containerLabel(labels, "com.docker.compose.project"); ok {
		if project == kubernetesDevelopmentComposeProject {
			return fmt.Errorf("%s: a Compose control plane with Kubernetes Compute (Compose project %s) may be running; stop it with OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes occ dev down, %s", prefix, project, move)
		}
		return fmt.Errorf("%s: a Docker-compatible development stack (Compose project %s) may be running; stop it with OCC_DEVELOPMENT_COMPUTE_DRIVER=docker occ dev down, %s", prefix, project, move)
	}
	return fmt.Errorf("%s; stop that container, %s", prefix, move)
}

// k3dRolledBackCleanly reports whether a failed k3d cluster create left
// nothing behind: k3d said it rolled back every change, the cluster is not
// listed, and no container carries its k3d.cluster label. Only then may the
// startup rollback remove its state directory; otherwise the directory stays
// for occ dev down.
func (r *runner) k3dRolledBackCleanly(ctx context.Context, createErr error, cluster string) bool {
	var failure *k3dCreateFailure
	if !errors.As(createErr, &failure) || !failure.rolledBack || ctx.Err() != nil {
		return false
	}
	exists, err := r.clusterExists(ctx, cluster)
	if err != nil || exists {
		return false
	}
	containers, err := r.output(ctx, r.engine, "ps", "--all", "--quiet", "--filter", "label=k3d.cluster="+cluster)
	return err == nil && len(containers) == 0
}

// kubernetesDownCommand is the cleanup command for a Kubernetes development
// state directory. Down selects nothing from the shell's profile exports, so
// it works from any shell.
func kubernetesDownCommand(directory, sandboxDriver, repository string) string {
	sandbox := ""
	if sandboxDriver == "openshell" {
		sandbox = " OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell"
	}
	return fmt.Sprintf("env OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes%s OCC_DEVELOPMENT_STATE_DIRECTORY=%s %s dev down", sandbox, shellQuote(directory), shellQuote(filepath.Join(repository, "bin", "occ")))
}
