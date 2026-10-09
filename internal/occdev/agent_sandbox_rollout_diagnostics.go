package occdev

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"time"
)

const (
	agentSandboxName         = "agent-sandbox-controller"
	agentSandboxNamespace    = "agent-sandbox-system"
	agentSandboxCaptureLimit = 256 * 1024
	agentSandboxRecordLimit  = 32 * 1024
)

// Projection happens inside kubectl, before any workload data reaches this process.
// printf %q can produce non-JSON escapes for hostile values; parsing fails closed.
const agentSandboxTemplateCommon = `{{define "s"}}{{if .}}{{printf "%q" .}}{{else}}""{{end}}{{end}}
{{define "n"}}{{if .}}{{printf "%v" .}}{{else}}0{{end}}{{end}}
{{define "identity"}}"name":{{template "s" .metadata.name}},"namespace":{{template "s" .metadata.namespace}},"uid":{{template "s" .metadata.uid}}{{end}}
{{define "owners"}}[{{range $i,$x := .}}{{if $i}},{{end}}{"kind":{{template "s" $x.kind}},"name":{{template "s" $x.name}},"uid":{{template "s" $x.uid}},"controller":{{if $x.controller}}true{{else}}false{{end}}}{{end}}]{{end}}
{{define "conditions"}}[{{range $i,$x := .}}{{if $i}},{{end}}{"type":{{template "s" $x.type}},"status":{{template "s" $x.status}},"reason":{{template "s" $x.reason}}}{{end}}]{{end}}
{{define "terminated"}}{{if .}}{"reason":{{template "s" .reason}},"exitCode":{{template "n" .exitCode}},"signal":{{template "n" .signal}}}{{else}}null{{end}}{{end}}
{{define "images"}}[{{range $i,$x := .}}{{if $i}},{{end}}{"name":{{template "s" $x.name}},"image":{{template "s" $x.image}}}{{end}}]{{end}}
{{define "containers"}}[{{range $i,$x := .}}{{if $i}},{{end}}{"name":{{template "s" $x.name}},"image":{{template "s" $x.image}},"imageID":{{template "s" $x.imageID}},"ready":{{if $x.ready}}true{{else}}false{{end}},"restartCount":{{template "n" $x.restartCount}},"waitingReason":{{with $x.state.waiting}}{{template "s" .reason}}{{else}}""{{end}},"terminated":{{template "terminated" $x.state.terminated}},"lastTerminated":{{template "terminated" $x.lastState.terminated}}}{{end}}]{{end}}
`

// Resource kind comes from the fixed GET, not optional TypeMeta in list items.
const agentSandboxDeploymentTemplate = agentSandboxTemplateCommon + `{"items":[{"kind":"Deployment", {{template "identity" .}},"owners":{{template "owners" .metadata.ownerReferences}},"selectorApp":{{template "s" (index .spec.selector.matchLabels "app")}},"selectorLabels":{{len .spec.selector.matchLabels}},"selectorExpressions":{{if .spec.selector.matchExpressions}}{{len .spec.selector.matchExpressions}}{{else}}0{{end}},"generation":{{template "n" .metadata.generation}},"observedGeneration":{{template "n" .status.observedGeneration}},"replicas":{{template "n" .status.replicas}},"updatedReplicas":{{template "n" .status.updatedReplicas}},"readyReplicas":{{template "n" .status.readyReplicas}},"availableReplicas":{{template "n" .status.availableReplicas}},"conditions":{{template "conditions" .status.conditions}}}]}`
const agentSandboxReplicaSetsTemplate = agentSandboxTemplateCommon + `{"items":[{{range $i,$x := .items}}{{if $i}},{{end}}{{with $x}}{"kind":"ReplicaSet", {{template "identity" .}},"app":{{template "s" (index .metadata.labels "app")}},"owners":{{template "owners" .metadata.ownerReferences}}}{{end}}{{end}}]}`
const agentSandboxPodsTemplate = agentSandboxTemplateCommon + `{"items":[{{range $i,$x := .items}}{{if $i}},{{end}}{{with $x}}{"kind":"Pod", {{template "identity" .}},"app":{{template "s" (index .metadata.labels "app")}},"owners":{{template "owners" .metadata.ownerReferences}},"phase":{{template "s" .status.phase}},"reason":{{template "s" .status.reason}},"conditions":{{template "conditions" .status.conditions}},"images":{{template "images" .spec.containers}},"initImages":{{template "images" .spec.initContainers}},"containers":{{template "containers" .status.containerStatuses}},"initContainers":{{template "containers" .status.initContainerStatuses}}}{{end}}{{end}}]}`
const agentSandboxWarningsTemplate = agentSandboxTemplateCommon + `{"items":[{{range $i,$x := .items}}{{if $i}},{{end}}{{with $x}}{"kind":"Event", {{template "identity" .}},"object":{"kind":{{template "s" .involvedObject.kind}},"name":{{template "s" .involvedObject.name}},"namespace":{{template "s" .involvedObject.namespace}},"uid":{{template "s" .involvedObject.uid}}},"type":{{template "s" .type}},"reason":{{template "s" .reason}},"count":{{template "n" .count}}}{{end}}{{end}}]}`

type agentSandboxIdentity struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	UID       string `json:"uid"`
}
type agentSandboxOwner struct {
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	UID        string `json:"uid"`
	Controller bool   `json:"controller"`
}
type agentSandboxCondition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
	Reason string `json:"reason"`
}
type agentSandboxTermination struct {
	Reason   string `json:"reason"`
	ExitCode int64  `json:"exitCode"`
	Signal   int64  `json:"signal"`
}
type agentSandboxContainer struct {
	Name           string                   `json:"name"`
	Image          string                   `json:"image,omitempty"`
	ImageID        string                   `json:"imageID,omitempty"`
	Ready          bool                     `json:"ready"`
	RestartCount   int64                    `json:"restartCount"`
	WaitingReason  string                   `json:"waitingReason"`
	Terminated     *agentSandboxTermination `json:"terminated,omitempty"`
	LastTerminated *agentSandboxTermination `json:"lastTerminated,omitempty"`
}
type agentSandboxImage struct {
	Name  string `json:"name"`
	Image string `json:"image"`
}

// The same narrow wire record is used for the four fixed projections. No raw
// API objects, free-form messages, environment or label inventory is retained.
type agentSandboxObject struct {
	agentSandboxIdentity
	Owners              []agentSandboxOwner     `json:"owners,omitempty"`
	App                 string                  `json:"app,omitempty"`
	SelectorApp         string                  `json:"selectorApp,omitempty"`
	SelectorLabels      int64                   `json:"selectorLabels,omitempty"`
	SelectorExpressions int64                   `json:"selectorExpressions,omitempty"`
	Generation          int64                   `json:"generation,omitempty"`
	ObservedGeneration  int64                   `json:"observedGeneration,omitempty"`
	Replicas            int64                   `json:"replicas,omitempty"`
	UpdatedReplicas     int64                   `json:"updatedReplicas,omitempty"`
	ReadyReplicas       int64                   `json:"readyReplicas,omitempty"`
	AvailableReplicas   int64                   `json:"availableReplicas,omitempty"`
	Phase               string                  `json:"phase,omitempty"`
	Reason              string                  `json:"reason,omitempty"`
	Conditions          []agentSandboxCondition `json:"conditions,omitempty"`
	Images              []agentSandboxImage     `json:"images,omitempty"`
	InitImages          []agentSandboxImage     `json:"initImages,omitempty"`
	Containers          []agentSandboxContainer `json:"containers,omitempty"`
	InitContainers      []agentSandboxContainer `json:"initContainers,omitempty"`
	Object              *agentSandboxIdentity   `json:"object,omitempty"`
	Type                string                  `json:"type,omitempty"`
	Count               int64                   `json:"count,omitempty"`
}
type agentSandboxStage struct {
	Status string               `json:"status"`
	Items  []agentSandboxObject `json:"items,omitempty"`
}
type agentSandboxDiagnostic struct {
	Diagnostic  string            `json:"diagnostic"`
	Deployment  agentSandboxStage `json:"deployment"`
	ReplicaSets agentSandboxStage `json:"replicaSets"`
	Pods        agentSandboxStage `json:"pods"`
	Warnings    agentSandboxStage `json:"warnings"`
}

// A fresh, finite budget permits capture after cancellation of startup. Run
// awaits each direct child; WaitDelay bounds inherited-pipe draining, not the
// lifetime of arbitrary descendants. Writing to the caller's io.Writer is best
// effort: its latency and durable storage are outside this subprocess budget.
func (r *runner) captureAgentSandboxRollout(state *developmentState) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	record := agentSandboxDiagnostic{Diagnostic: "agent-sandbox-rollout", ReplicaSets: agentSandboxStage{Status: "unavailable"}, Pods: agentSandboxStage{Status: "unavailable"}, Warnings: agentSandboxStage{Status: "unavailable"}}
	record.Deployment = r.agentSandboxRead(ctx, state, "deployment", agentSandboxDeploymentTemplate, 1)
	if record.Deployment.Status == "ok" {
		if len(record.Deployment.Items) != 1 || !agentSandboxDeploymentValid(record.Deployment.Items[0]) {
			record.Deployment = agentSandboxStage{Status: "ownership-rejected"}
		} else {
			deployment := record.Deployment.Items[0].agentSandboxIdentity
			parents := map[string]agentSandboxIdentity{deployment.UID: deployment}
			record.ReplicaSets = r.agentSandboxRead(ctx, state, "replicasets", agentSandboxReplicaSetsTemplate, 4)
			agentSandboxSelectOwned(&record.ReplicaSets, "ReplicaSet", parents)
			for uid, identity := range agentSandboxIdentities(record.ReplicaSets.Items) {
				parents[uid] = identity
			}
			record.Pods = r.agentSandboxRead(ctx, state, "pods", agentSandboxPodsTemplate, 8)
			agentSandboxSelectOwned(&record.Pods, "Pod", parents)
			for uid, identity := range agentSandboxIdentities(record.Pods.Items) {
				parents[uid] = identity
			}
			record.Warnings = r.agentSandboxRead(ctx, state, "events", agentSandboxWarningsTemplate, 32)
			selected := make([]agentSandboxObject, 0, len(record.Warnings.Items))
			for _, event := range record.Warnings.Items {
				if parents[event.UID].UID != "" || event.Kind != "Event" || event.Type != "Warning" || event.Object == nil || parents[event.Object.UID] != *event.Object {
					record.Warnings.Status = "ownership-rejected"
					continue
				}
				selected = append(selected, event)
			}
			record.Warnings.Items = selected
		}
	}
	data, err := json.Marshal(record)
	if err != nil || len(data)+1 > agentSandboxRecordLimit {
		data = []byte(`{"diagnostic":"agent-sandbox-rollout","status":"overflow"}`)
	}
	_, _ = fmt.Fprintln(r.opts.Err, string(data))
}

type agentSandboxOutput struct {
	buffer   bytes.Buffer
	cancel   context.CancelFunc
	overflow bool
}

func (b *agentSandboxOutput) Write(p []byte) (int, error) {
	if len(p) > agentSandboxCaptureLimit-b.buffer.Len() {
		b.overflow = true
		b.cancel()
		return 0, io.ErrShortBuffer
	}
	return b.buffer.Write(p)
}
func (r *runner) agentSandboxRead(ctx context.Context, state *developmentState, resource, projection string, limit int) agentSandboxStage {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	args := []string{"--kubeconfig", filepath.Join(state.directory, "kubeconfig"), "--context", "k3d-" + state.Cluster, "--request-timeout=3s", "--namespace", agentSandboxNamespace, "get", resource}
	switch resource {
	case "deployment":
		args = append(args, agentSandboxName)
	case "events":
		args = append(args, "--field-selector=type=Warning")
	default:
		args = append(args, "--selector=app="+agentSandboxName)
	}
	args = append(args, "-o", "go-template="+projection)
	cmd := r.command(ctx, "kubectl", args...)
	output := &agentSandboxOutput{cancel: cancel}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 200 * time.Millisecond
	err := cmd.Run()
	if output.overflow {
		return agentSandboxStage{Status: "overflow"}
	}
	if err != nil {
		return agentSandboxStage{Status: "unavailable"}
	}
	var wire struct {
		Items []agentSandboxObject `json:"items"`
	}
	decoder := json.NewDecoder(bytes.NewReader(output.buffer.Bytes()))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&wire) != nil || decoder.Decode(new(any)) != io.EOF || wire.Items == nil {
		return agentSandboxStage{Status: "malformed"}
	}
	if len(wire.Items) > limit {
		return agentSandboxStage{Status: "overflow"}
	}
	names := map[string]bool{}
	uids := map[string]bool{}
	for _, item := range wire.Items {
		if len(item.Owners) > 8 || len(item.Conditions) > 12 || len(item.Containers) > 8 || len(item.InitContainers) > 8 || len(item.Images) > 8 || len(item.InitImages) > 8 {
			return agentSandboxStage{Status: "overflow"}
		}
		if !agentSandboxObjectValid(item) || names[item.Name] || uids[item.UID] {
			return agentSandboxStage{Status: "malformed"}
		}
		names[item.Name], uids[item.UID] = true, true
	}
	return agentSandboxStage{Status: "ok", Items: wire.Items}
}

var agentSandboxNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)
var agentSandboxUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var agentSandboxCodePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,127}$`)
var agentSandboxImagePattern = regexp.MustCompile(`^((containerd://)?sha256:[0-9a-f]{64}|(docker-pullable://)?[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9_.-]+)?(@sha256:[0-9a-f]{64})?)$`)

func agentSandboxImageValid(value string) bool {
	return value == "" || len(value) <= 512 && agentSandboxImagePattern.MatchString(value)
}

func agentSandboxCode(value string) bool {
	return value == "" || agentSandboxCodePattern.MatchString(value)
}
func agentSandboxNumber(value int64) bool { return value >= 0 && value <= 2147483647 }
func agentSandboxIdentityValid(identity agentSandboxIdentity) bool {
	return identity.Namespace == agentSandboxNamespace && agentSandboxNamePattern.MatchString(identity.Name) && agentSandboxUIDPattern.MatchString(identity.UID) && agentSandboxCodePattern.MatchString(identity.Kind)
}
func agentSandboxObjectValid(item agentSandboxObject) bool {
	if !agentSandboxIdentityValid(item.agentSandboxIdentity) {
		return false
	}
	if !agentSandboxCode(item.App) || !agentSandboxCode(item.SelectorApp) || !agentSandboxCode(item.Phase) || !agentSandboxCode(item.Reason) || !agentSandboxCode(item.Type) {
		return false
	}
	for _, value := range []int64{item.SelectorLabels, item.SelectorExpressions, item.Generation, item.ObservedGeneration, item.Replicas, item.UpdatedReplicas, item.ReadyReplicas, item.AvailableReplicas, item.Count} {
		if !agentSandboxNumber(value) {
			return false
		}
	}
	for _, owner := range item.Owners {
		if !agentSandboxCodePattern.MatchString(owner.Kind) || !agentSandboxNamePattern.MatchString(owner.Name) || !agentSandboxUIDPattern.MatchString(owner.UID) {
			return false
		}
	}
	for _, condition := range item.Conditions {
		if !agentSandboxCodePattern.MatchString(condition.Type) || !agentSandboxCode(condition.Reason) || (condition.Status != "True" && condition.Status != "False" && condition.Status != "Unknown") {
			return false
		}
	}
	for _, group := range [][]agentSandboxImage{item.Images, item.InitImages} {
		for _, image := range group {
			if !agentSandboxNamePattern.MatchString(image.Name) || !agentSandboxImageValid(image.Image) {
				return false
			}
		}
	}
	for _, group := range [][]agentSandboxContainer{item.Containers, item.InitContainers} {
		for _, container := range group {
			if !agentSandboxNamePattern.MatchString(container.Name) || !agentSandboxNumber(container.RestartCount) || !agentSandboxCode(container.WaitingReason) || !agentSandboxImageValid(container.Image) || !agentSandboxImageValid(container.ImageID) {
				return false
			}
			for _, term := range []*agentSandboxTermination{container.Terminated, container.LastTerminated} {
				if term != nil && (!agentSandboxCode(term.Reason) || term.ExitCode < -2147483648 || term.ExitCode > 2147483647 || term.Signal < 0 || term.Signal > 128) {
					return false
				}
			}
		}
	}
	return item.Object == nil || agentSandboxIdentityValid(*item.Object)
}
func agentSandboxDeploymentValid(item agentSandboxObject) bool {
	return item.Kind == "Deployment" && item.Name == agentSandboxName && len(item.Owners) == 0 && item.SelectorApp == agentSandboxName && item.SelectorLabels == 1 && item.SelectorExpressions == 0
}
func agentSandboxSelectOwned(stage *agentSandboxStage, kind string, parents map[string]agentSandboxIdentity) {
	selected := make([]agentSandboxObject, 0, len(stage.Items))
	parentKind := "Deployment"
	if kind == "Pod" {
		parentKind = "ReplicaSet"
	}
	for _, item := range stage.Items {
		controllers := 0
		owned := false
		for _, owner := range item.Owners {
			if owner.Controller {
				controllers++
				parent, found := parents[owner.UID]
				owned = found && owner.Kind == parentKind && parent.Kind == owner.Kind && parent.Name == owner.Name && parent.Namespace == item.Namespace
			}
		}
		if item.Kind != kind || item.App != agentSandboxName || controllers != 1 || !owned || parents[item.UID].UID != "" {
			stage.Status = "ownership-rejected"
			continue
		}
		selected = append(selected, item)
	}
	stage.Items = selected
}
func agentSandboxIdentities(items []agentSandboxObject) map[string]agentSandboxIdentity {
	result := make(map[string]agentSandboxIdentity, len(items))
	for _, item := range items {
		result[item.UID] = item.agentSandboxIdentity
	}
	return result
}
