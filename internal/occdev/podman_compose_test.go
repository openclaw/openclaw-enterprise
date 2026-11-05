package occdev

import (
	"reflect"
	"strings"
	"testing"
)

func TestPodmanComposeArgsRejectsAnEmptyFileBeforeAddingDefaults(t *testing.T) {
	for _, args := range [][]string{
		{"--file="},
		{"--file", ""},
		{"-f"},
	} {
		got, err := podmanComposeArgs(args, "", "")
		if err == nil || !strings.Contains(err.Error(), "--file requires a Compose file path") || got != nil {
			t.Fatalf("%q: got %q, err %v", args, got, err)
		}
	}
	got, err := podmanComposeArgs([]string{"--file", "compose.override.yaml"}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--file", "compose.override.yaml", "-f", "compose.podman.yaml"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("explicit file = %q, want %q", got, want)
	}
	got, err = podmanComposeArgs(nil, "", "")
	if err != nil {
		t.Fatal(err)
	}
	want = []string{"-f", "compose.yaml", "-f", "compose.podman.yaml"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("omitted file = %q, want %q", got, want)
	}
}
