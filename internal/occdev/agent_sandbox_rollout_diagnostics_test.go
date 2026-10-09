package occdev

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"text/template"
	"time"
)

// This subprocess emulates only the selected kubectl/Helm operations and emits
// explicit projected fixtures. It exercises process and parser boundaries, but
// does not establish kubectl printer or live API behavior.
func TestAgentSandboxKubectlProcess(t *testing.T) {
	if os.Getenv("OCC_TEST_SANDBOX_PROCESS") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	if len(args) < 2 {
		os.Exit(97)
	}
	tool, args := args[1], args[2:]
	log, err := os.OpenFile(os.Getenv("OCC_TEST_SANDBOX_LOG"), os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0600)
	if err != nil {
		os.Exit(97)
	}
	_, _ = fmt.Fprintln(log, tool+" "+strings.Join(args, " "))
	_ = log.Close()
	if tool == "helm" {
		if len(args) > 0 && args[0] == "show" {
			os.Exit(0)
		}
		// Stop immediately after successful rollout, before image import is reachable.
		os.Exit(41)
	}
	if tool == "k3d" {
		if strings.Join(args, " ") == "cluster list -o json" {
			fmt.Fprint(os.Stdout, `[{"name":"occ-dev-owned"}]`)
			os.Exit(0)
		}
		if strings.Join(args, " ") == "cluster delete occ-dev-owned" {
			os.Exit(0)
		}
	}
	if tool != "kubectl" {
		os.Exit(97)
	}
	if args[0] == "apply" {
		os.Exit(0)
	}
	if args[0] == "rollout" {
		if os.Getenv("OCC_TEST_SANDBOX_ROLLOUT") == "cancel" {
			time.Sleep(30 * time.Second)
		}
		if os.Getenv("OCC_TEST_SANDBOX_ROLLOUT") == "success" {
			os.Exit(0)
		}
		os.Exit(42)
	}
	if args[0] == "pipe-holder" {
		time.Sleep(800 * time.Millisecond)
		os.Exit(0)
	}
	resource, projection := "", ""
	for i, arg := range args {
		if arg == "get" && i+1 < len(args) {
			resource = args[i+1]
		}
		if strings.HasPrefix(arg, "go-template=") {
			projection = strings.TrimPrefix(arg, "go-template=")
		}
	}
	if resource == "" || projection == "" {
		os.Exit(97)
	}
	switch os.Getenv("OCC_TEST_SANDBOX_MODE") {
	case "denied":
		fmt.Fprint(os.Stderr, "PRIVATE-API-ERROR")
		fmt.Fprint(os.Stdout, "PRIVATE-STDOUT")
		os.Exit(1)
	case "malformed":
		fmt.Fprint(os.Stdout, "PRIVATE-MALFORMED")
		os.Exit(0)
	case "oversized":
		_, _ = os.Stdout.Write(bytes.Repeat([]byte("X"), agentSandboxCaptureLimit+1))
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "hang":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "pipe":
		child := exec.Command(os.Args[0], "-test.run=^TestAgentSandboxKubectlProcess$", "--", "kubectl", "pipe-holder")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if child.Start() != nil {
			os.Exit(97)
		}
		// Intentionally orphan this short-lived fixture to exercise WaitDelay.
		os.Exit(0)
	case "project":
		data, err := os.ReadFile(filepath.Join(os.Getenv("OCC_TEST_SANDBOX_FIXTURES"), resource+".raw.json"))
		if err != nil {
			os.Exit(97)
		}
		var object any
		if json.Unmarshal(data, &object) != nil {
			os.Exit(97)
		}
		printer, err := template.New("kubectl").Parse(projection)
		if err != nil || printer.Execute(os.Stdout, object) != nil {
			os.Exit(97)
		}
		os.Exit(0)
	}
	data, err := os.ReadFile(filepath.Join(os.Getenv("OCC_TEST_SANDBOX_FIXTURES"), resource+".json"))
	if err != nil {
		os.Exit(97)
	}
	_, _ = os.Stdout.Write(data)
	os.Exit(0)
}

func agentSandboxTestRunner(t *testing.T) (*runner, *developmentState, *bytes.Buffer, string) {
	t.Helper()
	directory := t.TempDir()
	bin := filepath.Join(directory, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"kubectl", "helm", "docker", "podman", "k3d", "curl", "wget"} {
		script := "#!/bin/sh\nexec " + shellQuote(executable) + " -test.run='^TestAgentSandboxKubectlProcess$' -- " + name + " \"$@\"\n"
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	// No real executable can be reached through PATH, including on a regression.
	t.Setenv("PATH", bin)
	t.Setenv("OCC_TEST_SANDBOX_PROCESS", "1")
	t.Setenv("OCC_TEST_SANDBOX_LOG", filepath.Join(directory, "commands.log"))
	t.Setenv("OCC_TEST_SANDBOX_FIXTURES", directory)
	state := kubernetesOnlyOpenShellState(t)
	output := new(bytes.Buffer)
	r := newRunner(Options{Repository: state.Repository, Err: output})
	r.engine = "docker"
	chart := filepath.Join(directory, "chart")
	if err := os.Mkdir(chart, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(directory, "sandbox.yaml")
	if err := os.WriteFile(manifest, []byte("# inert manifest\n"), 0600); err != nil {
		t.Fatal(err)
	}
	r.env["OCC_DEVELOPMENT_OPENSHELL_HELM_CHART"] = chart
	r.env["OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART"] = chart
	r.env["OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST"] = manifest
	writeAgentSandboxFixtures(t, directory, agentSandboxTestObjects())
	return r, state, output, directory
}

func agentSandboxTestObjects() map[string]map[string]any {
	identity := func(kind, name, uid string) map[string]any {
		return map[string]any{"kind": kind, "name": name, "namespace": "agent-sandbox-system", "uid": uid}
	}
	owner := func(kind, name, uid string) []any {
		return []any{map[string]any{"kind": kind, "name": name, "uid": uid, "controller": true}}
	}
	d := identity("Deployment", "agent-sandbox-controller", "11111111-1111-1111-1111-111111111111")
	d["selectorApp"], d["selectorLabels"] = "agent-sandbox-controller", 1
	d["conditions"] = []any{map[string]any{"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded"}}
	rs := identity("ReplicaSet", "agent-sandbox-controller-abc", "22222222-2222-2222-2222-222222222222")
	rs["app"] = "agent-sandbox-controller"
	rs["owners"] = owner("Deployment", "agent-sandbox-controller", "11111111-1111-1111-1111-111111111111")
	pod := identity("Pod", "agent-sandbox-controller-abc-def", "33333333-3333-3333-3333-333333333333")
	pod["app"] = "agent-sandbox-controller"
	pod["owners"] = owner("ReplicaSet", "agent-sandbox-controller-abc", "22222222-2222-2222-2222-222222222222")
	pod["phase"] = "Pending"
	pod["conditions"] = []any{map[string]any{"type": "PodScheduled", "status": "False", "reason": "Unschedulable"}}
	pod["containers"] = []any{map[string]any{"name": "controller", "restartCount": 2, "waitingReason": "ImagePullBackOff", "lastTerminated": map[string]any{"reason": "Error", "exitCode": 1}}}
	event := identity("Event", "agent-sandbox-controller-warning", "44444444-4444-4444-4444-444444444444")
	event["object"] = identity("Pod", "agent-sandbox-controller-abc-def", "33333333-3333-3333-3333-333333333333")
	event["type"], event["reason"], event["count"] = "Warning", "FailedScheduling", 3
	return map[string]map[string]any{"deployment": {"items": []any{d}}, "replicasets": {"items": []any{rs}}, "pods": {"items": []any{pod}}, "events": {"items": []any{event}}}
}
func writeAgentSandboxFixtures(t *testing.T, directory string, objects map[string]map[string]any) {
	t.Helper()
	for name, object := range objects {
		data, err := json.Marshal(object)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, name+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
func readAgentSandboxRecord(t *testing.T, output *bytes.Buffer) agentSandboxDiagnostic {
	t.Helper()
	var record agentSandboxDiagnostic
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatalf("missing diagnostic record: %v", err)
	}
	if output.Len() > agentSandboxRecordLimit || bytes.Contains(output.Bytes(), []byte("PRIVATE")) {
		t.Fatal("unbounded or private diagnostic")
	}
	return record
}

func TestAgentSandboxRolloutDiagnosticsBeforeReturn(t *testing.T) {
	r, state, output, directory := agentSandboxTestRunner(t)
	// Exercise the preparation/cleanup boundary with inert subprocesses. This
	// does not run the launcher's earlier cluster provisioning steps.
	_, err := r.prepareOpenShell(context.Background(), state, 7*time.Second)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 42 || err.Error() != "kubectl failed: exit status 42" {
		t.Fatalf("rollout error changed: %v", err)
	}
	record := readAgentSandboxRecord(t, output)
	if record.Deployment.Status != "ok" || len(record.ReplicaSets.Items) != 1 || len(record.Pods.Items) != 1 || len(record.Warnings.Items) != 1 {
		t.Fatalf("missing owned chain: %+v", record)
	}
	pod := record.Pods.Items[0]
	if pod.Conditions[0].Reason != "Unschedulable" || pod.Containers[0].WaitingReason != "ImagePullBackOff" || pod.Containers[0].LastTerminated.ExitCode != 1 || record.Warnings.Items[0].Count != 3 {
		t.Fatal("lost rollout reasons")
	}
	log, err := os.ReadFile(filepath.Join(directory, "commands.log"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(log), " get ") != 4 || !strings.Contains(string(log), "rollout status deployment/agent-sandbox-controller --namespace agent-sandbox-system --timeout 7s") {
		t.Fatal("changed rollout or repeated capture")
	}
	if err := r.cleanup(context.Background(), state, true); err != nil {
		t.Fatal(err)
	}
	log, err = os.ReadFile(filepath.Join(directory, "commands.log"))
	if err != nil || strings.LastIndex(string(log), " get events ") > strings.LastIndex(string(log), "k3d cluster delete ") || !strings.Contains(string(log), "k3d cluster delete ") {
		t.Fatal("capture did not precede cleanup")
	}
	if err := os.RemoveAll(state.directory); err != nil {
		t.Fatal(err)
	}
	if output.Len() == 0 {
		t.Fatal("cleanup removed evidence")
	}
}
func TestAgentSandboxRolloutSuccessDoesNotRead(t *testing.T) {
	r, state, output, directory := agentSandboxTestRunner(t)
	r.env["OCC_TEST_SANDBOX_ROLLOUT"] = "success"
	_, err := r.prepareOpenShell(context.Background(), state, time.Second)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 41 {
		t.Fatalf("did not reach later chart rendering: %v", err)
	}
	log, _ := os.ReadFile(filepath.Join(directory, "commands.log"))
	if output.Len() != 0 || strings.Contains(string(log), " get ") {
		t.Fatal("successful rollout performed diagnostics")
	}
}
func TestAgentSandboxRolloutDiagnosticsRejectOwnership(t *testing.T) {
	for _, scenario := range []string{"selector", "deployment-kind", "owner-name", "owner-kind", "owner-uid", "no-controller", "ambiguous", "foreign-namespace", "pod-owner", "event-name", "event-kind", "event-namespace", "duplicate", "uid-collision", "pod-app"} {
		t.Run(scenario, func(t *testing.T) {
			r, state, output, directory := agentSandboxTestRunner(t)
			objects := agentSandboxTestObjects()
			rs := objects["replicasets"]["items"].([]any)[0].(map[string]any)
			owners := rs["owners"].([]any)
			first := owners[0].(map[string]any)
			event := objects["events"]["items"].([]any)[0].(map[string]any)["object"].(map[string]any)
			switch scenario {
			case "selector":
				objects["deployment"]["items"].([]any)[0].(map[string]any)["selectorLabels"] = 2
			case "deployment-kind":
				objects["deployment"]["items"].([]any)[0].(map[string]any)["kind"] = "ReplicaSet"
			case "owner-name":
				first["name"] = "foreign"
			case "owner-kind":
				first["kind"] = "StatefulSet"
			case "owner-uid":
				first["uid"] = "99999999-9999-9999-9999-999999999999"
			case "no-controller":
				first["controller"] = false
			case "ambiguous":
				rs["owners"] = append(owners, first)
			case "foreign-namespace":
				rs["namespace"] = "foreign"
			case "pod-owner":
				objects["pods"]["items"].([]any)[0].(map[string]any)["owners"].([]any)[0].(map[string]any)["name"] = "foreign"
			case "event-name":
				event["name"] = "foreign"
			case "event-kind":
				event["kind"] = "Deployment"
			case "event-namespace":
				event["namespace"] = "foreign"
			case "uid-collision":
				objects["pods"]["items"].([]any)[0].(map[string]any)["uid"] = "11111111-1111-1111-1111-111111111111"
			case "pod-app":
				objects["pods"]["items"].([]any)[0].(map[string]any)["app"] = "foreign"
			case "duplicate":
				objects["replicasets"]["items"] = []any{rs, rs}
			}
			writeAgentSandboxFixtures(t, directory, objects)
			r.captureAgentSandboxRollout(state)
			record := readAgentSandboxRecord(t, output)
			if len(record.Warnings.Items) != 0 {
				t.Fatal("accepted event for foreign/spoofed chain")
			}
			if !strings.HasPrefix(scenario, "event-") && len(record.Pods.Items) != 0 {
				t.Fatal("accepted foreign/spoofed pod")
			}
		})
	}
}
func TestAgentSandboxRolloutDiagnosticsBounds(t *testing.T) {
	for _, scenario := range []string{"hostile-reason", "hostile-name", "message", "env", "number", "conditions", "containers", "objects", "malformed", "denied", "oversized", "hang", "pipe"} {
		t.Run(scenario, func(t *testing.T) {
			r, state, output, directory := agentSandboxTestRunner(t)
			objects := agentSandboxTestObjects()
			pod := objects["pods"]["items"].([]any)[0].(map[string]any)
			status := pod
			switch scenario {
			case "hostile-reason":
				status["reason"] = "PRIVATE\nTOKEN"
			case "message", "env":
				pod[scenario] = "PRIVATE-TOKEN"
			case "hostile-name":
				pod["name"] = strings.Repeat("a", 254)
			case "number":
				status["containers"].([]any)[0].(map[string]any)["restartCount"] = int64(2147483648)
			case "conditions":
				status["conditions"] = make([]any, 13)
			case "containers":
				status["containers"] = make([]any, 9)
			case "objects":
				objects["pods"]["items"] = []any{pod, pod, pod, pod, pod, pod, pod, pod, pod}
			default:
				r.env["OCC_TEST_SANDBOX_MODE"] = scenario
			}
			writeAgentSandboxFixtures(t, directory, objects)
			started := time.Now()
			_, err := r.prepareOpenShell(context.Background(), state, time.Second)
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 42 || err.Error() != "kubectl failed: exit status 42" {
				t.Fatalf("diagnostic failure replaced rollout error: %v", err)
			}
			record := readAgentSandboxRecord(t, output)
			if time.Since(started) > 4*time.Second {
				t.Fatal("capture did not settle within command/pipe bound")
			}
			if len(record.Pods.Items) > 0 {
				t.Fatal("accepted invalid pod")
			}
			switch scenario {
			case "denied", "hang", "pipe":
				if record.Deployment.Status != "unavailable" {
					t.Fatal(record.Deployment.Status)
				}
			case "oversized":
				if record.Deployment.Status != "overflow" {
					t.Fatal(record.Deployment.Status)
				}
			case "malformed":
				if record.Deployment.Status != "malformed" {
					t.Fatal(record.Deployment.Status)
				}
			}
			// The inherited-pipe fixture is finite; allow its child to exit before the
			// temporary fixture directory is removed. No descendant-kill claim is made.
			if scenario == "pipe" {
				time.Sleep(900 * time.Millisecond)
			}
		})
	}
}
func TestAgentSandboxRolloutDiagnosticsCancellation(t *testing.T) {
	r, state, output, _ := agentSandboxTestRunner(t)
	r.env["OCC_TEST_SANDBOX_ROLLOUT"] = "cancel"
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, err := r.prepareOpenShell(ctx, state, time.Second)
	if err == nil || ctx.Err() != context.DeadlineExceeded {
		t.Fatalf("rollout was not cancelled: %v", err)
	}
	if readAgentSandboxRecord(t, output).Deployment.Status != "ok" {
		t.Fatal("startup cancellation prevented capture")
	}
	r.env["OCC_TEST_SANDBOX_MODE"] = "hang"
	started := time.Now()
	stage := r.agentSandboxRead(ctx, state, "deployment", agentSandboxDeploymentTemplate, 1)
	if stage.Status != "unavailable" || time.Since(started) > time.Second {
		t.Fatal("cancelled command did not settle")
	}
}

func TestAgentSandboxRolloutDiagnosticsRecordBound(t *testing.T) {
	r, state, output, directory := agentSandboxTestRunner(t)
	objects := agentSandboxTestObjects()
	pods := make([]any, 0, 8)
	// Each object stays within its individual caps, but their combined record
	// exceeds 32 KiB. The final record must use the fixed overflow marker.
	for i := 0; i < 8; i++ {
		pod := agentSandboxTestObjects()["pods"]["items"].([]any)[0].(map[string]any)
		pod["name"] = fmt.Sprintf("agent-sandbox-controller-abc-%d", i)
		pod["uid"] = fmt.Sprintf("33333333-3333-3333-3333-%012d", i)
		conditions := make([]any, 12)
		for j := range conditions {
			conditions[j] = map[string]any{"type": strings.Repeat("C", 128), "status": "False", "reason": strings.Repeat("R", 128)}
		}
		containers := make([]any, 8)
		for j := range containers {
			containers[j] = map[string]any{"name": fmt.Sprintf("container-%d", j), "waitingReason": strings.Repeat("R", 128)}
		}
		pod["conditions"], pod["containers"] = conditions, containers
		pods = append(pods, pod)
	}
	objects["pods"]["items"] = pods
	writeAgentSandboxFixtures(t, directory, objects)
	r.captureAgentSandboxRollout(state)
	if output.String() != "{\"diagnostic\":\"agent-sandbox-rollout\",\"status\":\"overflow\"}\n" {
		t.Fatal("missing bounded final-record fallback")
	}
}

type agentSandboxFailingWriter struct{ err error }

func (w agentSandboxFailingWriter) Write([]byte) (int, error) { return 0, w.err }
func TestAgentSandboxRolloutDiagnosticsWriterFailure(t *testing.T) {
	r, state, _, _ := agentSandboxTestRunner(t)
	failure := errors.New("diagnostic writer failed")
	r.opts.Err = agentSandboxFailingWriter{err: failure}
	_, err := r.prepareOpenShell(context.Background(), state, time.Second)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 42 || errors.Is(err, failure) || err.Error() != "kubectl failed: exit status 42" {
		t.Fatalf("writer changed primary rollout failure: %v", err)
	}
}

func TestAgentSandboxRolloutDiagnosticsProjection(t *testing.T) {
	for _, scenario := range []string{"owned", "foreign", "hostile-image"} {
		t.Run(scenario, func(t *testing.T) {
			r, state, output, directory := agentSandboxTestRunner(t)
			r.env["OCC_TEST_SANDBOX_MODE"] = "project"
			// Render the production templates from API-shaped objects, including
			// list items without TypeMeta. Nonselected content must stay private.
			for resource, projected := range agentSandboxTestObjects() {
				item := projected["items"].([]any)[0].(map[string]any)
				metadata := map[string]any{
					"name": item["name"], "namespace": item["namespace"], "uid": item["uid"],
					"ownerReferences": item["owners"],
					"labels":          map[string]any{"app": agentSandboxName, "private": "PRIVATE-LABEL"},
					"generation":      2,
				}
				raw := map[string]any{"metadata": metadata}
				switch resource {
				case "deployment":
					raw["spec"] = map[string]any{"selector": map[string]any{"matchLabels": map[string]any{"app": agentSandboxName}}}
					raw["status"] = map[string]any{"observedGeneration": 2, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 0, "availableReplicas": 0, "conditions": item["conditions"]}
				case "pods":
					image := "registry.example.invalid/controller:v1"
					if scenario == "hostile-image" {
						image += "?PRIVATE-IMAGE"
					}
					raw["spec"] = map[string]any{"containers": []any{map[string]any{
						"name": "controller", "image": image,
						"env": []any{map[string]any{"name": "PRIVATE-ENV", "value": "PRIVATE-VALUE"}},
					}}}
					raw["status"] = map[string]any{
						"phase": item["phase"], "conditions": item["conditions"], "message": "PRIVATE-MESSAGE",
						"containerStatuses": []any{map[string]any{
							"name": "controller", "image": image, "imageID": "containerd://sha256:" + strings.Repeat("a", 64),
							"restartCount": 2, "state": map[string]any{"waiting": map[string]any{"reason": "ImagePullBackOff", "message": "PRIVATE-WAITING"}},
							"lastState": map[string]any{"terminated": map[string]any{"reason": "Error", "exitCode": 1, "message": "PRIVATE-EXIT"}},
						}},
					}
					if scenario == "foreign" {
						metadata["ownerReferences"].([]any)[0].(map[string]any)["uid"] = "99999999-9999-9999-9999-999999999999"
					}
				case "events":
					raw["involvedObject"], raw["type"], raw["reason"], raw["count"] = item["object"], "Warning", "FailedScheduling", 3
					raw["message"] = "PRIVATE-EVENT"
				}
				var response any = raw
				if resource != "deployment" {
					response = map[string]any{"items": []any{raw}}
				}
				data, err := json.Marshal(response)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(directory, resource+".raw.json"), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			_, err := r.prepareOpenShell(context.Background(), state, time.Second)
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 42 {
				t.Fatalf("changed rollout error: %v", err)
			}
			record := readAgentSandboxRecord(t, output)
			if scenario != "owned" {
				if len(record.Pods.Items) != 0 || len(record.Warnings.Items) != 0 {
					t.Fatal("projection admitted hostile or unrelated metadata")
				}
				return
			}
			if record.Deployment.Items[0].UpdatedReplicas != 1 || len(record.Pods.Items) != 1 || len(record.Warnings.Items) != 1 {
				t.Fatal("projection lost selected metadata")
			}
			pod := record.Pods.Items[0]
			if len(pod.Images) != 1 || pod.Images[0].Image != "registry.example.invalid/controller:v1" ||
				len(pod.Containers) != 1 || pod.Containers[0].ImageID != "containerd://sha256:"+strings.Repeat("a", 64) ||
				pod.Containers[0].WaitingReason != "ImagePullBackOff" {
				t.Fatal("projection lost image identity or waiting reason")
			}
		})
	}
}
