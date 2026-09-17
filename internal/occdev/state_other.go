//go:build !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd

package occdev

import (
	"fmt"
	"os"
	"runtime"
)

func checkKubernetesPlatform() error {
	return fmt.Errorf("local Kubernetes development is unsupported on %s; use a supported Unix host", runtime.GOOS)
}

func privateOwned(string, bool) error    { return checkKubernetesPlatform() }
func lockState(string) (*os.File, error) { return nil, checkKubernetesPlatform() }
