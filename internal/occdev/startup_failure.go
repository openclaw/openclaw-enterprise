package occdev

import (
	"context"
	"errors"
	"fmt"
)

// startupFailure names the returning owner without changing its error text or chain.
type startupFailure struct {
	stage             string
	cleanupFailed     bool
	routingOperation  string
	routingController string
	err               error
}

func (e *startupFailure) Error() string { return e.err.Error() }
func (e *startupFailure) Unwrap() error { return e.err }

func startupError(stage string, err error) error {
	if err == nil {
		return nil
	}
	if singleStartupCause(err) == context.Canceled {
		stage = "canceled"
	}
	if singleStartupCause(err) == context.DeadlineExceeded {
		stage = "deadline"
	}
	failure := &startupFailure{stage: stage, err: err}
	// Ordinary context wrapping preserves the selected failure. Stop at the
	// first classification or a multi-error; never search siblings or cleanup.
	for current := err; current != nil; current = errors.Unwrap(current) {
		if selected, ok := current.(*startupFailure); ok {
			failure.cleanupFailed = selected.cleanupFailed
			if stage == "routing" && selected.stage == "routing" {
				failure.routingOperation = selected.routingOperation
				failure.routingController = selected.routingController
			}
			break
		}
	}
	return failure
}

func startupFailureDetails(err error) (string, bool) {
	// Inspect only the selected primary wrapper. Searching an errors.Join tree
	// could misattribute an unclassified primary to a tagged cleanup failure.
	if failure, ok := err.(*startupFailure); ok {
		switch failure.stage {
		case "canceled", "deadline", "routing", "network-verification", "network-cleanup", "registry-detach", "platform-namespace", "openshell-preparation", "rollback":
			return failure.stage, failure.cleanupFailed
		}
		return "unknown", failure.cleanupFailed
	}
	if singleStartupCause(err) == context.Canceled {
		return "canceled", false
	}
	if singleStartupCause(err) == context.DeadlineExceeded {
		return "deadline", false
	}
	return "unknown", false
}

func joinStartupCleanup(primary, cleanup error) error {
	if cleanup == nil {
		return primary
	}
	selected := primary
	if selected == nil {
		selected = cleanup
	}
	stage, _ := startupFailureDetails(selected)
	failure := startupError(stage, selected).(*startupFailure)
	failure.cleanupFailed = true
	failure.err = errors.Join(primary, cleanup)
	return failure
}

// Multi-errors have no implicit primary. Only follow ordinary wrapping.
func singleStartupCause(err error) error {
	for {
		wrapped, ok := err.(interface{ Unwrap() error })
		if !ok {
			return err
		}
		err = wrapped.Unwrap()
	}
}

// Routing operations supply fixed metadata at their failure boundary. Never
// derive these fields from command output, resource names, or error messages.
func routingError(operation, controller string, err error) error {
	if err == nil {
		return nil
	}
	failure := startupError("routing", err).(*startupFailure)
	failure.routingOperation = operation
	failure.routingController = controller
	return failure
}

func routingFailureSuffix(err error) string {
	failure, ok := err.(*startupFailure)
	if !ok || failure.stage != "routing" {
		return ""
	}
	switch failure.routingOperation {
	case "node-pod-cidr":
		if failure.routingController == "" {
			return " routing_operation=node-pod-cidr"
		}
	case "manifest-download", "gateway-api-readiness", "manifest-filter", "manifest-write", "manifest-apply", "controller-crd-readiness", "controller-rollout", "gateway-class-apply", "gateway-class-readiness":
		if failure.routingController == "cert-manager" || failure.routingController == "envoy-gateway" {
			return fmt.Sprintf(" routing_operation=%s routing_controller=%s", failure.routingOperation, failure.routingController)
		}
	}
	return ""
}
