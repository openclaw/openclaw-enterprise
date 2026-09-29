package occdev

import (
	"encoding/json"
	"os/exec"
	"testing"
)

// developmentCodexProfileNames asks the preparation script's own module for the
// localhost profile name it builds for every reviewed Codex version.
//
// The names are produced by the real Node code rather than restated here. A
// test that rebuilt the name from a version constant would agree with itself
// while the two sides drifted apart, which is exactly the failure this guards.
func developmentCodexProfileNames(t *testing.T) []string {
	t.Helper()
	// A minimal RuntimeDefault baseline: the derivation validates its shape and
	// appends the reviewed bwrap rules, so the resulting digest is stable
	// without needing a cluster to report a real node profile.
	const script = `
const { deriveCodexBwrapProfile, reviewedCodexVersions } = await import("../../scripts/lib/codex-seccomp-profile.mjs");
const { developmentCodexProfileName } = await import("../../scripts/lib/codex-seccomp-k3d.mjs");
const baseline = {
  architectures: ["SCMP_ARCH_X86_64"],
  defaultAction: "SCMP_ACT_ERRNO",
  syscalls: [
    { names: ["read"], action: "SCMP_ACT_ALLOW" },
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  ],
};
process.stdout.write(JSON.stringify(reviewedCodexVersions.map((version) =>
  developmentCodexProfileName(deriveCodexBwrapProfile(baseline, { codexVersion: version }), version),
)));
`
	command := exec.Command("node", "--input-type=module", "-e", script)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("could not build Codex profile names with the preparation module: %v", err)
	}
	var names []string
	if err := json.Unmarshal(output, &names); err != nil {
		t.Fatalf("invalid profile name list: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("the preparation module reported no reviewed Codex versions")
	}
	return names
}

func TestDevelopmentCodexSeccompAcceptsEveryReviewedProfileName(t *testing.T) {
	for _, name := range developmentCodexProfileNames(t) {
		if !validDevelopmentCodexSeccompResult("Localhost", name) {
			t.Errorf("the lifecycle rejected the profile name the preparation script installs: %s", name)
		}
	}
}

func TestDevelopmentCodexSeccompAcceptsAnUnconfinedRuntimeDefaultNode(t *testing.T) {
	// A node whose RuntimeDefault profile already denies the Codex sandbox needs
	// no localhost profile, and the script reports that with an empty name.
	if !validDevelopmentCodexSeccompResult("RuntimeDefault", "") {
		t.Error("RuntimeDefault with no installed profile must be accepted")
	}
}

func TestDevelopmentCodexSeccompRejectsUnusableResults(t *testing.T) {
	// Each case is a result the lifecycle must refuse to act on, because acting
	// on it would run the Codex sandbox under a profile nobody verified.
	for _, testCase := range []struct {
		name        string
		mode        string
		profileName string
	}{
		{"an unknown mode", "Unconfined", ""},
		{"an empty mode", "", ""},
		{"RuntimeDefault naming a profile it did not install", "RuntimeDefault", "openclaw/codex-0.158.0-" + hex64 + ".json"},
		{"Localhost without a profile", "Localhost", ""},
		{"a profile outside the openclaw prefix", "Localhost", "other/codex-0.158.0-" + hex64 + ".json"},
		{"an absolute profile path", "Localhost", "/openclaw/codex-0.158.0-" + hex64 + ".json"},
		{"a traversing profile path", "Localhost", "openclaw/../codex-0.158.0-" + hex64 + ".json"},
		{"a profile with no content digest", "Localhost", "openclaw/codex-0.158.0.json"},
		{"a profile with a truncated digest", "Localhost", "openclaw/codex-0.158.0-abc123.json"},
		{"a profile with no version", "Localhost", "openclaw/codex-" + hex64 + ".json"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if validDevelopmentCodexSeccompResult(testCase.mode, testCase.profileName) {
				t.Errorf("accepted an unusable result: mode %q profile %q", testCase.mode, testCase.profileName)
			}
		})
	}
}

const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
