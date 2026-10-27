package occdev

import (
	"context"
	"strings"
	"testing"
)

// fakeComposeContainers fakes the container engine for routing file
// preparation. `ps` applies its label filters to OCC_TEST_CONTAINERS (one
// "<id> <label>=<value>..." line per container) the way the engine does.
func fakeComposeContainers(t *testing.T, engine, containers string) func() []string {
	t.Helper()
	t.Setenv("OCC_TEST_CONTAINERS", containers)
	return fakeProfileCommands(t, map[string]string{engine: `
"compose "*) ;;
"ps --all --quiet "*)
  filters=$(printf '%s\n' "$@" | sed -n 's/^label=//p')
  printf '%s\n' "$OCC_TEST_CONTAINERS" | while read -r id labels; do
    [ -n "$id" ] || continue
    match=1
    for filter in $filters; do
      case " $labels " in *" $filter "*) ;; *) match=0 ;; esac
    done
    if [ "$match" = 1 ]; then echo "$id"; fi
  done ;;
"inspect --format "*) echo '{"image":"reader-image","user":""}' ;;
"run --rm --network none --read-only --user 0:0 "*) ;;
"run --rm --network none --read-only "*) echo '[1000,1000]' ;;
`})
}

func composeRoutingState(t *testing.T) *developmentState {
	t.Helper()
	return &developmentState{Repository: t.TempDir(), ComposeProject: "occ-test", directory: t.TempDir()}
}

func TestComposeRoutingFilesIgnoreDockerComposeRunContainers(t *testing.T) {
	// A user's `docker compose run controller ...` leaves a one-off container
	// with the same project and service labels; Docker Compose marks it
	// oneoff=True. Ownership must still resolve the single service container.
	commands := fakeComposeContainers(t, "docker", strings.Join([]string{
		"service-controller com.docker.compose.project=occ-test com.docker.compose.service=controller com.docker.compose.oneoff=False",
		"run-controller com.docker.compose.project=occ-test com.docker.compose.service=controller com.docker.compose.oneoff=True",
		"service-worker com.docker.compose.project=occ-test com.docker.compose.service=worker-kubernetes com.docker.compose.oneoff=False",
	}, "\n"))
	r := newRunner(Options{})
	r.engine = "docker"
	if err := r.prepareComposeRoutingFiles(context.Background(), composeRoutingState(t)); err != nil {
		t.Fatalf("routing file preparation failed with a one-off container present: %v", err)
	}
	for _, command := range commands() {
		if strings.HasPrefix(command, "docker inspect ") && strings.HasSuffix(command, " run-controller") {
			t.Fatalf("inspected the one-off container: %s", command)
		}
	}
}

func TestComposeRoutingFilesFindPodmanComposeContainersWithoutOneoffLabel(t *testing.T) {
	// podman-compose sets no oneoff label, so a Docker-only filter must not
	// hide its service containers.
	fakeComposeContainers(t, "podman", strings.Join([]string{
		"service-controller com.docker.compose.project=occ-test com.docker.compose.service=controller",
		"service-worker com.docker.compose.project=occ-test com.docker.compose.service=worker-kubernetes",
	}, "\n"))
	r := newRunner(Options{})
	r.engine = "podman"
	if err := r.prepareComposeRoutingFiles(context.Background(), composeRoutingState(t)); err != nil {
		t.Fatalf("routing file preparation failed for podman-compose containers: %v", err)
	}
}
