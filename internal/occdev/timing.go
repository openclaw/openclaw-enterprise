package occdev

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"time"
)

// Report expensive development commands without their arguments, environment or
// output. Commands still run directly under their original cancellation context.
// Concurrent commands overlap: these durations are not additive wall time.
func (r *runner) commandTiming(name string, args []string, started time.Time, err error) {
	stage := developmentCommandStage(filepath.Base(name), args)
	if stage == "" || r.opts.Out == nil {
		return
	}
	outcome := ""
	if stage == "runtime-build" {
		if result := runtimeBuildFailureOutcome(err); result != "" {
			// Keep the legacy timing line intact for readers that only collect timings.
			outcome = "\n[occ-dev-outcome] stage=runtime-build outcome=" + result
		}
	}
	fmt.Fprintf(r.opts.Out, "\n[occ-dev-timing] stage=%s elapsed_ms=%d failed=%t%s\n", stage, time.Since(started).Milliseconds(), err != nil, outcome)
}

func runtimeBuildFailureOutcome(err error) string {
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ProcessState == nil {
		return ""
	}
	if exit.Exited() && exit.ExitCode() > 0 {
		return "nonzero-exit"
	}
	if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return "signaled"
	}
	return ""
}

func developmentCommandStage(name string, args []string) string {
	if len(args) == 0 {
		return ""
	}
	switch name {
	case "docker", "podman":
		switch args[0] {
		case "build", "buildx":
			if args[0] == "buildx" && (len(args) < 2 || args[1] != "build") {
				return ""
			}
			for _, arg := range args {
				if filepath.ToSlash(arg) == "deploy/runtime/Dockerfile" {
					return "runtime-build"
				}
			}
			return "controller-build"
		case "compose":
			if slices.Contains(args, "up") {
				return "compose-build-and-start"
			}
			if slices.Contains(args, "build") {
				return "compose-build"
			}
		case "pull":
			return "image-pull"
		case "image":
			if len(args) > 1 && args[1] == "save" {
				return "image-export"
			}
		case "exec":
			if slices.Contains(args, "images") && slices.Contains(args, "import") {
				return "image-import"
			}
			if slices.Contains(args, "images") && slices.Contains(args, "pull") {
				return "node-image-pull"
			}
		}
	case "k3d":
		if len(args) > 1 && args[0] == "cluster" && args[1] == "create" {
			return "cluster-create"
		}
		if len(args) > 1 && args[0] == "image" && args[1] == "import" {
			return "k3d-image-import"
		}
	case "kubectl":
		if slices.Contains(args, "wait") || (slices.Contains(args, "rollout") && slices.Contains(args, "status")) {
			return "kubernetes-readiness"
		}
	case "helm":
		if args[0] == "upgrade" || args[0] == "install" {
			return "helm-install"
		}
	}
	return ""
}
