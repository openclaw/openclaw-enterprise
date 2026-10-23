//go:build !linux && !darwin

package occdev

import (
	"fmt"
	"os/exec"
)

func ownComposeProcessGroup(*exec.Cmd) (func() error, error) {
	return nil, fmt.Errorf("Kubernetes development requires Linux or macOS process groups")
}
