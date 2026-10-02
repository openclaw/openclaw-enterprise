package occdev

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWaitForCRDEstablishedRetriesWhileConditionsAreNil(t *testing.T) {
	// kubectl wait exits immediately when status.conditions is nil, before its
	// timeout. A CRD that has just been applied is in that state. Startup must
	// read the object again and continue until Established is True.
	directory := t.TempDir()
	count := filepath.Join(directory, "count")
	log := filepath.Join(directory, "log")
	script := "#!/bin/sh\n" +
		"echo \"$*\" >> " + shellQuote(log) + "\n" +
		"case \"$*\" in\n" +
		"*wait*) echo \"used kubectl wait\" >&2; exit 97 ;;\n" +
		"\"get crd securitypolicies.gateway.envoyproxy.io --ignore-not-found -o json\")\n" +
		"  n=0\n" +
		"  if [ -f " + shellQuote(count) + " ]; then n=$(cat " + shellQuote(count) + "); fi\n" +
		"  n=$((n+1))\n" +
		"  echo \"$n\" > " + shellQuote(count) + "\n" +
		"  if [ \"$n\" -eq 1 ]; then\n" +
		"    printf '%s\\n' '{\"status\":{\"conditions\":null}}'\n" +
		"    exit 0\n" +
		"  fi\n" +
		"  printf '%s\\n' '{\"status\":{\"conditions\":[{\"type\":\"Established\",\"status\":\"True\"}]}}'\n" +
		"  exit 0 ;;\n" +
		"*) echo \"unexpected: $*\" >&2; exit 99 ;;\n" +
		"esac\n"
	installFakeKubectl(t, script)
	runner := newRunner(Options{Repository: t.TempDir()})

	if err := runner.waitForCRDEstablished(context.Background(), "securitypolicies.gateway.envoyproxy.io", 3*time.Second); err != nil {
		t.Fatal(err)
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(calls), "wait") {
		t.Fatalf("used kubectl wait: %s", calls)
	}
}

func TestWaitForCRDEstablishedTimesOutWhileConditionsStayNil(t *testing.T) {
	installFakeKubectl(t, `#!/bin/sh
case "$*" in
"get crd securitypolicies.gateway.envoyproxy.io --ignore-not-found -o json")
  printf '%s\n' '{"status":{"conditions":null}}'
  exit 0 ;;
*) echo "unexpected: $*" >&2; exit 99 ;;
esac
`)
	runner := newRunner(Options{Repository: t.TempDir()})
	if err := runner.waitForCRDEstablished(context.Background(), "securitypolicies.gateway.envoyproxy.io", 200*time.Millisecond); err == nil {
		t.Fatal("succeeded while conditions stayed nil")
	}
}

func TestWaitForCRDEstablishedReturnsKubectlFailure(t *testing.T) {
	installFakeKubectl(t, `#!/bin/sh
echo "kubectl get failed" >&2
exit 1
`)
	runner := newRunner(Options{Repository: t.TempDir()})
	started := time.Now()
	err := runner.waitForCRDEstablished(context.Background(), "securitypolicies.gateway.envoyproxy.io", 5*time.Second)
	if err == nil {
		t.Fatal("accepted a failed kubectl read")
	}
	if time.Since(started) > time.Second {
		t.Fatal("kept polling after kubectl failed")
	}
}

func TestDevelopmentCRDEstablishedReadsTheCondition(t *testing.T) {
	established, err := developmentCRDEstablished([]byte(`{"apiVersion":"apiextensions.k8s.io/v1","kind":"CustomResourceDefinition","metadata":{"name":"securitypolicies.gateway.envoyproxy.io"},"spec":{"group":"gateway.envoyproxy.io"},"status":{"conditions":[{"type":"NamesAccepted","status":"True"},{"type":"Established","status":"True"}]}}`))
	if err != nil || !established {
		t.Fatalf("established=%v err=%v", established, err)
	}
	established, err = developmentCRDEstablished([]byte(`{"status":{"conditions":[{"type":"Established","status":"False"}]}}`))
	if err != nil || established {
		t.Fatalf("false condition: established=%v err=%v", established, err)
	}
	established, err = developmentCRDEstablished(nil)
	if err != nil || established {
		t.Fatalf("missing CRD: established=%v err=%v", established, err)
	}
	if _, err = developmentCRDEstablished([]byte(`not-json`)); err == nil {
		t.Fatal("accepted invalid CRD status")
	}
}

func installFakeKubectl(t *testing.T, script string) {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
}
