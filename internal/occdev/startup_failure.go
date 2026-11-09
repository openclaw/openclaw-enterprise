package occdev

import (
	"context"
	"errors"
)

// startupFailure names the returning owner without changing its error text or chain.
type startupFailure struct {
	stage         string
	cleanupFailed bool
	err           error
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
	return &startupFailure{stage: stage, err: err}
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
	return &startupFailure{stage: stage, cleanupFailed: true, err: errors.Join(primary, cleanup)}
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
