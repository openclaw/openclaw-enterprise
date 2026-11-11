package occdev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Command-boundary coverage of the actual default preload/importer, not a
// container engine test. The release manifest/config bytes are independently pinned.
func TestAgentSandboxNativeCacheImport(t *testing.T) {
	for _, scenario := range []string{"index-only", "config-id-store", "lost-descriptor", "cri-cache-lag", "cri-engine-error", "cri-wrong-reference", "cri-deadline", "child-local", "pull-child", "descriptor-only", "engine-error", "mixed-error", "wrong-repository", "wrong-child", "wrong-native-id", "wrong-annotation", "wrong-platform", "missing-platform", "null-platform", "wrong-imported-config"} {
		t.Run(scenario, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			marker := filepath.Join(state.directory, "tag")
			pulled := filepath.Join(state.directory, "pulled")
			manifest := filepath.Join(state.directory, "sandbox.yaml")
			if err := os.WriteFile(manifest, []byte("      - name: agent-sandbox-controller\n        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\n"), 0600); err != nil {
				t.Fatal(err)
			}
			nodes := `{"items":[{"status":{"nodeInfo":{"operatingSystem":"linux","architecture":"amd64"}}}]}`
			source := "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6"
			selected := struct{ configDigest, cacheIndex string }{
				"sha256:5b6c81129dc7491b3d260940e34ff68323fb6f7f21450d42129be5169e52ab17",
				"registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403",
			}
			_, child, _ := strings.Cut(source, "@")
			_, index, _ := strings.Cut(selected.cacheIndex, "@")
			repo := "registry.k8s.io/agent-sandbox/agent-sandbox-controller"
			metadata := func(id, digest, osName, arch, media string) string {
				value := []any{map[string]any{"Id": id, "RepoDigests": []string{repo + "@" + digest}, "Os": osName, "Architecture": arch, "Descriptor": map[string]string{"mediaType": media, "digest": id}}}
				data, _ := json.Marshal(value)
				return "echo " + shellQuote(string(data))
			}
			childReply := metadata(child, child, "linux", "amd64", "application/vnd.oci.image.manifest.v1+json")
			indexReply := metadata(index, index, "linux", "amd64", "application/vnd.oci.image.index.v1+json")
			nativeReply := metadata(child, index, "linux", "amd64", "application/vnd.oci.image.manifest.v1+json")
			if scenario == "config-id-store" || scenario == "lost-descriptor" {
				// The descriptor-free store identifies its loaded native config;
				// this is a command-contract fixture, not native engine proof.
				data, err := json.Marshal([]any{map[string]any{"Id": selected.configDigest, "RepoDigests": []string{repo + "@" + index}, "Os": "linux", "Architecture": "amd64"}})
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "lost-descriptor" {
					nativeReply = "echo " + shellQuote(string(data))
				} else {
					indexReply = "echo " + shellQuote(string(data))
					nativeReply = "echo platform-inspect-unavailable >&2; exit 17"
				}
			}
			absent := "for image do :; done; printf 'Error response from daemon: No such image: %s\n' \"$image\" >&2; exit 1"
			pullReply := "echo 'offline registry: cache hit must not pull' >&2; exit 61"
			if scenario == "pull-child" || scenario == "descriptor-only" {
				pullReply = ": > " + shellQuote(pulled)
			}

			localChild := "if [ -f " + shellQuote(pulled) + " ]; then " + childReply + "; else " + absent + "; fi"
			if scenario == "child-local" {
				localChild = childReply
			}
			if scenario == "pull-child" {
				indexReply = absent
			}
			if scenario == "descriptor-only" {
				nativeReply = metadata(child, index, "", "", "application/vnd.oci.image.manifest.v1+json")
			}
			if scenario == "engine-error" {
				localChild = "echo 'engine unavailable' >&2; exit 17"
			}
			if scenario == "mixed-error" {
				localChild = "echo 'Cannot connect to daemon: No such image: " + source + "' >&2; exit 1"
			}
			switch scenario {
			case "wrong-native-id":
				nativeReply = strings.Replace(nativeReply, `"Id":"`+child+`"`, `"Id":"`+index+`"`, 1)
			case "wrong-annotation":
				nativeReply = strings.Replace(nativeReply, `"Descriptor":{`, `"Descriptor":{"annotations":{"config.digest":"`+index+`"},`, 1)
			case "wrong-platform":
				nativeReply = strings.Replace(nativeReply, `"Descriptor":{`, `"Descriptor":{"platform":{"os":"linux","architecture":"arm64"},`, 1)
			case "missing-platform":
				for _, field := range []string{`"Os":"linux"`, `"Architecture":"amd64"`} {
					nativeReply = strings.ReplaceAll(strings.ReplaceAll(nativeReply, ","+field, ""), field+",", "")
				}
			case "null-platform":
				nativeReply = strings.Replace(strings.Replace(nativeReply, `"Os":"linux"`, `"Os":null`, 1), `"Architecture":"amd64"`, `"Architecture":null`, 1)
			}
			if scenario == "wrong-repository" {
				indexReply = strings.ReplaceAll(indexReply, repo, "registry.example/foreign")
			}
			if scenario == "wrong-child" {
				nativeReply = metadata(index, index, "linux", "amd64", "application/vnd.oci.image.manifest.v1+json")
			}
			content, err := os.ReadFile("../../tests/fixtures/agent-sandbox-v0.5.2-amd64-manifest.json.txt")
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "wrong-imported-config" {
				content = []byte(strings.ReplaceAll(string(content), selected.configDigest, "sha256:"+strings.Repeat("a", 64)))
			}
			sum := sha256.Sum256(content)
			digest := "sha256:" + hex.EncodeToString(sum[:])
			blob := filepath.Join(state.directory, "native.json")
			if err := os.WriteFile(blob, content, 0600); err != nil {
				t.Fatal(err)
			}
			stage := "openclaw-development/openshell-agent-sandbox-controller:" + state.Cluster
			reference := "openclaw-development/openshell-agent-sandbox-controller@" + digest
			node := "k3d-" + state.Cluster + "-server-0"
			criMarker := filepath.Join(state.directory, "cri-seen")
			criReply := `echo '{"status":{"id":"` + selected.configDigest + `","repoDigests":["` + reference + `"]}}'`
			missingCRI := `echo 'time="2026-10-06T11:05:15Z" level=fatal msg="no such image \"` + reference + `\" present"' >&2; exit 1`
			switch scenario {
			case "cri-cache-lag":
				criReply = "if [ ! -f " + shellQuote(criMarker) + " ]; then : > " + shellQuote(criMarker) + "; " + missingCRI + "; fi; " + criReply
			case "cri-deadline":
				criReply = missingCRI
			case "cri-engine-error":
				criReply = "echo 'Cannot connect to daemon' >&2; exit 1"
			case "cri-wrong-reference":
				criReply = strings.ReplaceAll(criReply, reference, "registry.example/foreign@"+digest)
			}
			commands := fakeProfileCommands(t, map[string]string{
				"kubectl": `"get nodes -o json") echo '` + nodes + `' ;;`,
				"docker": `"image inspect ` + source + `") ` + localChild + ` ;;
"image inspect ` + selected.cacheIndex + `") ` + indexReply + ` ;;
"image inspect --platform linux/amd64 ` + source + `") ` + childReply + ` ;;
"image inspect --platform linux/amd64 ` + selected.cacheIndex + `") ` + nativeReply + ` ;;
"pull ` + source + `") ` + pullReply + ` ;;
"image inspect ` + stage + `") if [ -f ` + shellQuote(marker) + ` ]; then /bin/cat ` + shellQuote(marker) + `; else ` + absent + `; fi ;;
"tag ` + source + ` ` + stage + `") ` + childReply + ` > ` + shellQuote(marker) + ` ;;
"tag ` + selected.cacheIndex + ` ` + stage + `") ` + indexReply + ` > ` + shellQuote(marker) + ` ;;
"image inspect --format {{json .RepoTags}} ` + stage + `") echo '["` + stage + `"]' ;;
"image save --platform linux/amd64 --output "*" ` + stage + `") printf archive > "$6" ;;
"exec ` + node + ` ctr -n k8s.io images list") echo '` + stage + ` application/vnd.oci.image.manifest.v1+json ` + digest + `' ;;
"exec ` + node + ` ctr -n k8s.io images tag ` + stage + ` ` + reference + `") ;;
"exec ` + node + ` ctr -n k8s.io content get ` + digest + `") /bin/cat ` + shellQuote(blob) + ` ;;
"exec ` + node + ` crictl inspecti ` + reference + `") ` + criReply + ` ;;
"image rm ` + stage + `") /bin/rm ` + shellQuote(marker) + ` ;;`,
				"k3d": `"image import --mode direct "*" -c ` + state.Cluster + `") ;;`,
			})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			delete(r.env, "OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST")
			ctx := context.Background()
			if scenario == "cri-deadline" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 500*time.Millisecond)
				defer cancel()
			}
			output, err := r.preloadAgentSandboxController(ctx, state, state.directory, manifest)
			failed := slices.Contains([]string{"lost-descriptor", "cri-engine-error", "cri-wrong-reference", "cri-deadline", "engine-error", "mixed-error", "wrong-repository", "wrong-child", "wrong-native-id", "wrong-annotation", "wrong-platform", "missing-platform", "null-platform", "wrong-imported-config"}, scenario)
			if failed {
				if err == nil {
					t.Fatal("invalid image accepted")
				}
				if _, err := os.Stat(filepath.Join(state.directory, "agent-sandbox-local.yaml")); !os.IsNotExist(err) {
					t.Fatal("invalid image produced deployment input")
				}
			} else {
				if err != nil {
					t.Fatalf("%v\n%v", err, commands())
				}
				data, err := os.ReadFile(output)
				if err != nil || !strings.Contains(string(data), "image: "+reference+"\n        imagePullPolicy: Never") {
					t.Fatalf("wrong deployment image: %s %v", data, err)
				}
			}
			calls := commands()
			criCalls := 0
			for _, call := range calls {
				if strings.Contains(call, "crictl inspecti") {
					criCalls++
				}
			}
			if scenario == "cri-cache-lag" && criCalls != 2 {
				t.Fatalf("cache lag was not retried once: %v", calls)
			}
			if (scenario == "cri-engine-error" || scenario == "cri-wrong-reference") && criCalls != 1 {
				t.Fatalf("non-cache failure was retried: %v", calls)
			}
			if scenario == "cri-deadline" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("cache retry did not honor cancellation: %v", err)
			}
			wantPull := scenario == "pull-child" || scenario == "descriptor-only"
			if slices.Contains(calls, "docker pull "+source) != wantPull {
				t.Fatalf("wrong acquisition path: %v", calls)
			}
			if slices.ContainsFunc(calls, func(call string) bool {
				return strings.Contains(call, "imagetools") || strings.Contains(call, "manifest inspect")
			}) {
				t.Fatalf("native cache needed registry discovery: %v", calls)
			}
			if state.OpenShellImageTag != nil {
				t.Fatalf("staging custody remains: %+v", state.OpenShellImageTag)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("staging tag remains")
			}
		})
	}
}

func TestOpenShellStagingTagRecovery(t *testing.T) {
	for _, scenario := range []string{"success", "inspect-error", "tag-failed-before", "tag-failed-after", "remove-failed", "replaced", "state-write-failed"} {
		t.Run(scenario, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			source := "registry.example/gateway@" + profileTestDigest
			stage := "openclaw-development/openshell-gateway:" + state.Cluster
			marker := filepath.Join(state.directory, "tag")
			proof := filepath.Join(state.directory, "intent.json")
			id := profileTestDigest
			jsonImage := `[{"Id":"` + id + `"}]`
			inspect := `if [ -f ` + shellQuote(marker) + ` ]; then /bin/cat ` + shellQuote(marker) + `; else for image do :; done; printf 'Error response from daemon: No such image: %s\n' "$image" >&2; exit 1; fi`
			tag := `/bin/cp ` + shellQuote(filepath.Join(state.directory, "state.json")) + ` ` + shellQuote(proof) + `; echo '` + jsonImage + `' > ` + shellQuote(marker)
			if scenario == "inspect-error" {
				inspect = "exit 17"
			}
			if scenario == "tag-failed-before" {
				tag = `/bin/cp ` + shellQuote(filepath.Join(state.directory, "state.json")) + ` ` + shellQuote(proof) + `; exit 17`
			}
			if scenario == "tag-failed-after" {
				tag += "; exit 17"
			}
			remove := `/bin/rm ` + shellQuote(marker)
			failureMarker := filepath.Join(state.directory, "remove-failure")
			if scenario == "remove-failed" {
				if err := os.WriteFile(failureMarker, nil, 0600); err != nil {
					t.Fatal(err)
				}
				remove = "if [ -f " + shellQuote(failureMarker) + " ]; then exit 17; fi; " + remove
			}
			if scenario == "state-write-failed" {
				if err := os.Mkdir(filepath.Join(state.directory, "state.json"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			commands := fakeProfileCommands(t, map[string]string{"docker": `"image inspect ` + stage + `") ` + inspect + ` ;;
"tag ` + source + ` ` + stage + `") ` + tag + ` ;;
"image rm ` + stage + `") ` + remove + ` ;;`, "k3d": `"cluster list -o json") echo '[]' ;;`})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			err := r.stageOpenShellImage(context.Background(), state, source, stage, id)
			if (err != nil) != slices.Contains([]string{"inspect-error", "tag-failed-before", "tag-failed-after", "state-write-failed"}, scenario) {
				t.Fatalf("stage error: %v", err)
			}
			if scenario == "inspect-error" || scenario == "state-write-failed" {
				if slices.Contains(commands(), "docker tag "+source+" "+stage) {
					t.Fatal("mutated a tag without confirmed absence and persisted intent")
				}
				return
			}
			// The engine captured disk state at the mutation boundary, so this proves
			// write-ahead ordering rather than merely seeding a recovery record.
			data, err := os.ReadFile(proof)
			if err != nil {
				t.Fatal(err)
			}
			var saved developmentState
			if err := json.Unmarshal(data, &saved); err != nil || saved.OpenShellImageTag == nil || saved.OpenShellImageTag.ImageID != id {
				t.Fatalf("missing disk intent: %s %v", data, err)
			}
			if scenario == "replaced" {
				if err := os.WriteFile(marker, []byte(`[{"Id":"sha256:`+strings.Repeat("b", 64)+`"}]`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			// A fresh runner/state represents recovery after the original owner exited.
			recovered := saved
			recovered.directory = state.directory
			err = r.cleanup(context.Background(), &recovered, false)
			held := scenario == "remove-failed" || scenario == "replaced"
			if (err != nil) != held {
				t.Fatalf("cleanup error: %v", err)
			}
			if (recovered.OpenShellImageTag != nil) != held {
				t.Fatalf("lost custody: %+v", recovered.OpenShellImageTag)
			}
			if held {
				if _, err := os.Stat(marker); err != nil {
					t.Fatal("lost unresolved tag")
				}
				if scenario == "replaced" && slices.Contains(commands(), "docker image rm "+stage) {
					t.Fatal("removed a foreign replacement")
				}
			} else if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("owned tag remains")
			}
			// Recovery state must survive a failed removal and support a later normal
			// cleanup once the exact owned tag is conclusively absent.
			if held {
				target := marker
				if scenario == "remove-failed" {
					target = failureMarker
				}
				if err := os.Remove(target); err != nil {
					t.Fatal(err)
				}
				if err := r.cleanup(context.Background(), &recovered, false); err != nil {
					t.Fatal(err)
				}
				if recovered.OpenShellImageTag != nil {
					t.Fatal("absent tag kept custody")
				}
			}
		})
	}
}

// Kill the real importing test process after the fake engine created its tag.
// Recovery must come from disk through Down, not the importer's deferred cleanup.
func TestOpenShellImportInterruptedTag(t *testing.T) {
	if directory := os.Getenv("OCE_IMPORT_INTERRUPTION_STATE"); directory != "" {
		state, err := readState(directory)
		if err != nil {
			t.Fatal(err)
		}
		r := newRunner(Options{Repository: state.Repository})
		r.engine = "docker"
		_, err = r.importOpenShellImage(context.Background(), state, directory, "gateway", "registry.example/gateway@"+profileTestDigest, true, nil)
		t.Fatalf("interrupted import returned: %v", err)
	}
	state := kubernetesOnlyOpenShellState(t)
	state.DockerHost = "unix:///fixture/docker.sock"
	state.KeyPath = filepath.Join(state.directory, "unused-key.json")
	if err := os.WriteFile(filepath.Join(state.directory, ".openclaw-development"), []byte(stateMarker), 0600); err != nil {
		t.Fatal(err)
	}
	if err := rewriteState(state); err != nil {
		t.Fatal(err)
	}
	// The host-tag marker is outside the state directory; removing state alone
	// cannot satisfy the cleanup assertion.
	marker := filepath.Join(t.TempDir(), "host-tag")
	stage := "openclaw-development/openshell-gateway:" + state.Cluster
	source := "registry.example/gateway@" + profileTestDigest
	held := `echo '[{"Id":"` + profileTestDigest + `"}]'`
	commands := fakeProfileCommands(t, map[string]string{
		"docker": `"image inspect ` + source + `") ` + held + ` ;;
"image inspect --format {{.Os}}/{{.Architecture}} ` + source + `") echo linux/amd64 ;;
"image inspect ` + stage + `") if [ -f ` + shellQuote(marker) + ` ]; then ` + held + `; else for image do :; done; printf 'Error response from daemon: No such image: %s\n' "$image" >&2; exit 1; fi ;;
"tag ` + source + ` ` + stage + `") : > ` + shellQuote(marker) + `; kill -KILL "$PPID" ;;
"image rm ` + stage + `") /bin/rm ` + shellQuote(marker) + ` ;;
"volume ls "*) ;;`,
		"k3d": `"cluster list -o json") echo '[]' ;;`,
	})
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestOpenShellImportInterruptedTag$")
	cmd.Env = append(os.Environ(), "OCE_IMPORT_INTERRUPTION_STATE="+state.directory)
	err = cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || !strings.Contains(err.Error(), "killed") {
		t.Fatalf("import was not interrupted as intended: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var disk map[string]any
	if err := json.Unmarshal(data, &disk); err != nil {
		t.Fatal(err)
	}
	if disk["openShellImageTag"] == nil {
		t.Fatal("interrupted importer left no durable tag intent")
	}
	t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state.directory)
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "kubernetes")
	t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "openshell")
	if err := Down(context.Background(), Options{Repository: state.Repository}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("Down did not remove the interrupted import's host tag")
	}
	if _, err := os.Stat(state.directory); !os.IsNotExist(err) {
		t.Fatal("completed recovery retained its state directory")
	}
	if !slices.Contains(commands(), "docker image rm "+stage) {
		t.Fatal("recovery did not use the exact staging name")
	}
}

// A quoted absence inside another failure cannot authorize a tag write or erase
// the only recovery receipt. These cases exercise both sides of custody.
func TestOpenShellAmbiguousImageAbsence(t *testing.T) {
	for _, scenario := range []string{"mixed", "wrong-object", "truncated", "truncated-stdout", "open-pipe", "signaled"} {
		t.Run(scenario, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			state.DockerHost = "unix:///fixture/recovery.sock"
			state.KeyPath = filepath.Join(state.directory, "unused-key.json")
			if err := os.WriteFile(filepath.Join(state.directory, ".openclaw-development"), []byte(stateMarker), 0600); err != nil {
				t.Fatal(err)
			}
			stage := "openclaw-development/openshell-gateway:" + state.Cluster
			missing := "Error response from daemon: No such image: " + stage
			diagnostic := "printf '%s\n' " + shellQuote("Cannot connect to engine\n"+missing) + " >&2; exit 1"
			switch scenario {
			case "wrong-object":
				diagnostic = "echo " + shellQuote(missing+"-foreign") + " >&2; exit 1"
			case "truncated":
				diagnostic = "printf '%65536s' x >&2; echo " + shellQuote(missing) + " >&2; exit 1"
			case "truncated-stdout":
				diagnostic = "printf unexpected; printf '%4194304s' ''; echo " + shellQuote(missing) + " >&2; exit 1"
			case "open-pipe":
				// The direct child exits normally; an inherited writer prevents
				// proof that its otherwise valid absence result is complete.
				diagnostic = "(/bin/sleep 2) & echo " + shellQuote(missing) + " >&2; exit 1"
			case "signaled":
				diagnostic = "echo " + shellQuote(missing) + " >&2; kill -TERM $$"
			}
			commands := fakeProfileCommands(t, map[string]string{"docker": `"image inspect ` + stage + `") ` + diagnostic + ` ;;`})
			r := newRunner(Options{Repository: state.Repository})
			r.engine = "docker"
			if err := r.stageOpenShellImage(context.Background(), state, "registry.example/source@"+profileTestDigest, stage, profileTestDigest); err == nil {
				t.Fatal("ambiguous absence admitted staging")
			}
			state.OpenShellImageTag = &openShellImageTag{Name: stage, ImageID: profileTestDigest}
			if err := rewriteState(state); err != nil {
				t.Fatal(err)
			}
			if err := r.reconcileOpenShellImageTag(context.Background(), state); err == nil {
				t.Fatal("ambiguous absence discharged custody")
			}
			saved, err := readState(state.directory)
			if err != nil || saved.OpenShellImageTag == nil {
				t.Fatalf("lost durable custody: %v", err)
			}
			for _, call := range commands() {
				if !strings.HasPrefix(call, "docker image inspect ") {
					t.Fatalf("unexpected mutation: %s", call)
				}
			}
		})
	}
}

func TestOpenShellRecoveryBoundsAndProvider(t *testing.T) {
	for _, scenario := range []string{"hung-removal", "missing-provider"} {
		t.Run(scenario, func(t *testing.T) {
			state := kubernetesOnlyOpenShellState(t)
			state.DockerHost = "unix:///fixture/recovery.sock"
			state.KeyPath = filepath.Join(state.directory, "unused-key.json")
			stage := "openclaw-development/openshell-gateway:" + state.Cluster
			state.OpenShellImageTag = &openShellImageTag{Name: stage, ImageID: profileTestDigest}
			engine := "docker"
			if scenario == "missing-provider" {
				engine = "podman"
				state.ContainerEngine = engine
				state.DeploymentMode = ""
				state.ComposeProject = "occ-dev-owned"
				if err := os.WriteFile(filepath.Join(state.directory, "compose.yaml"), []byte("services: {}\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(state.directory, ".openclaw-development"), []byte(stateMarker), 0600); err != nil {
				t.Fatal(err)
			}
			if err := rewriteState(state); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(t.TempDir(), "host-tag")
			hang := filepath.Join(t.TempDir(), "hang")
			if err := os.WriteFile(marker, nil, 0600); err != nil {
				t.Fatal(err)
			}
			if scenario == "hung-removal" {
				if err := os.WriteFile(hang, nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			commands := fakeProfileCommands(t, map[string]string{engine: `"image inspect ` + stage + `") if [ -f ` + shellQuote(marker) + ` ]; then echo '[{"Id":"` + profileTestDigest + `"}]'; else echo 'Error response from daemon: No such image: ` + stage + `' >&2; exit 1; fi ;;
"image rm ` + stage + `") test "$DOCKER_HOST" = 'unix:///fixture/recovery.sock' || exit 89; if [ -f ` + shellQuote(hang) + ` ]; then /bin/sleep 2 & wait; fi; /bin/rm ` + shellQuote(marker) + ` ;;
"volume ls "*) ;;`, "k3d": `"cluster list -o json") echo '[]' ;;`})
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state.directory)
			t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "kubernetes")
			t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "openshell")
			if scenario == "hung-removal" {
				r := newRunner(Options{Repository: state.Repository})
				r.engine = engine
				r.useEndpoint(state.DockerHost)
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				defer cancel()
				start := time.Now()
				err := r.reconcileOpenShellImageTag(ctx, state)
				if err == nil || time.Since(start) > time.Second {
					t.Fatalf("unbounded or successful hung removal: %v", err)
				}
				if state.OpenShellImageTag == nil {
					t.Fatal("timeout lost custody")
				}
				if err := os.Remove(hang); err != nil {
					t.Fatal(err)
				}
			} else {
				// Only the fake engine remains on PATH; no Compose provider exists.
				t.Setenv("PATH", strings.Split(os.Getenv("PATH"), string(os.PathListSeparator))[0])
			}
			err := Down(context.Background(), Options{Repository: state.Repository})
			if scenario == "missing-provider" {
				if err == nil || !strings.Contains(err.Error(), "compose") {
					t.Fatalf("provider failure not retained: %v", err)
				}
				saved, readErr := readState(state.directory)
				if readErr != nil || saved.OpenShellImageTag != nil {
					t.Fatalf("host custody not independently recovered: %v", readErr)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("Down left host tag")
			}
			if !slices.Contains(commands(), engine+" image rm "+stage) {
				t.Fatal("missing owned removal")
			}
		})
	}
}
