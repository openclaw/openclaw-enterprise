package occdev

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMain(m *testing.M) {
	if runtime.GOOS == "darwin" {
		// Fixtures pass temporary paths as explicit state directories, whose
		// parents must be canonical. macOS commonly aliases /var to /private/var.
		temporary, err := filepath.EvalSymlinks(os.TempDir())
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := os.Setenv("TMPDIR", temporary); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}
