package occdev

import (
	"strings"
	"testing"
)

func TestValidateClusterNameExplainsTheRequiredPrefix(t *testing.T) {
	for _, name := range []string{"occ-dev-example", "occ-dev-0abc-1"} {
		if err := validateClusterName(name); err != nil {
			t.Fatalf("validateClusterName(%q) = %v", name, err)
		}
	}
	for _, name := range []string{"oce-dogfood", "occ-dev-", "occ-dev-Upper", "occ-dev-" + strings.Repeat("a", 56)} {
		err := validateClusterName(name)
		if err == nil {
			t.Fatalf("validateClusterName(%q) accepted an invalid name", name)
		}
		for _, want := range []string{"OCC_DEVELOPMENT_KUBERNETES_CLUSTER", `"` + name + `"`, "occ-dev-", "32"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("validateClusterName(%q) error %q does not mention %q", name, err, want)
			}
		}
	}
}
