package occdev

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func developmentAutomationObserverKubectl(t *testing.T, bindingPath string) {
	t.Helper()
	t.Setenv("OCC_TEST_OBSERVER_BINDING", bindingPath)
	fakeEngine(t, "kubectl", `
"get rolebinding openclaw-development-automation-observer -n owned-bootstrap --ignore-not-found -o json")
  if [ -f "$OCC_TEST_OBSERVER_BINDING" ]; then cat "$OCC_TEST_OBSERVER_BINDING"; fi ;;
"create -f "*)
  if [ -e "$OCC_TEST_OBSERVER_BINDING" ]; then exit 1; fi
  cp "$3" "$OCC_TEST_OBSERVER_BINDING" ;;
`)
}

func TestDevelopmentAutomationObserverBindingUsesTenantNamespaceAndAPISubject(t *testing.T) {
	state := &developmentState{PlatformNamespace: "control-plane", directory: t.TempDir()}
	path := filepath.Join(t.TempDir(), "binding.json")
	developmentAutomationObserverKubectl(t, path)
	r := newRunner(Options{})

	if err := r.installDevelopmentAutomationObserver(context.Background(), state, "owned-bootstrap", "ns-owned"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var binding developmentAutomationObserverBinding
	if err := json.Unmarshal(data, &binding); err != nil {
		t.Fatal(err)
	}
	if binding.Kind != "RoleBinding" || binding.Metadata.Name != "openclaw-development-automation-observer" || binding.Metadata.Namespace != "owned-bootstrap" {
		t.Fatalf("observer binding escaped the bootstrap Namespace: kind=%q name=%q namespace=%q", binding.Kind, binding.Metadata.Name, binding.Metadata.Namespace)
	}
	if binding.Metadata.Labels["app.kubernetes.io/managed-by"] != "openclaw-development" || binding.Metadata.Annotations["openclaw.dev/namespace-id"] != "ns-owned" {
		t.Fatalf("observer binding lacks bootstrap ownership evidence")
	}
	if binding.RoleRef.APIGroup != "rbac.authorization.k8s.io" || binding.RoleRef.Kind != "ClusterRole" || binding.RoleRef.Name != "openclaw-enterprise-openclaw-tenant-automation-observer" {
		t.Fatalf("unexpected automation observer role: %+v", binding.RoleRef)
	}
	if len(binding.Subjects) != 1 || binding.Subjects[0].Kind != "ServiceAccount" || binding.Subjects[0].Name != "openclaw-enterprise-api" || binding.Subjects[0].Namespace != "control-plane" {
		t.Fatalf("unexpected observer subjects: %+v", binding.Subjects)
	}
	// A repeat call must accept the same owned binding without recreating or changing it.
	if err := r.installDevelopmentAutomationObserver(context.Background(), state, "owned-bootstrap", "ns-owned"); err != nil {
		t.Fatalf("repeat binding failed: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(data) {
		t.Fatalf("repeat call changed the binding: %v", err)
	}
}

func TestDevelopmentAutomationObserverBindingRefusesConflicts(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*developmentAutomationObserverBinding)
	}{
		{"unowned", func(b *developmentAutomationObserverBinding) {
			delete(b.Metadata.Labels, "app.kubernetes.io/managed-by")
		}},
		{"another Namespace owner", func(b *developmentAutomationObserverBinding) {
			b.Metadata.Annotations["openclaw.dev/namespace-id"] = "ns-other"
		}},
		{"another role", func(b *developmentAutomationObserverBinding) { b.RoleRef.Name = "other-role" }},
		{"another subject", func(b *developmentAutomationObserverBinding) { b.Subjects[0].Name = "other-account" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &developmentState{PlatformNamespace: "control-plane", directory: t.TempDir()}
			path := filepath.Join(t.TempDir(), "binding.json")
			developmentAutomationObserverKubectl(t, path)
			r := newRunner(Options{})
			if err := r.installDevelopmentAutomationObserver(context.Background(), state, "owned-bootstrap", "ns-owned"); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var binding developmentAutomationObserverBinding
			if err := json.Unmarshal(data, &binding); err != nil {
				t.Fatal(err)
			}
			tc.mutate(&binding)
			data, err = json.Marshal(binding)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			err = r.installDevelopmentAutomationObserver(context.Background(), state, "owned-bootstrap", "ns-owned")
			if err == nil || !strings.Contains(err.Error(), "conflicting automation observer binding") {
				t.Fatalf("conflicting binding was accepted: %v", err)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(after) != string(data) {
				t.Fatalf("conflicting binding changed: %v", err)
			}
		})
	}
}

func TestDevelopmentAutomationObserverBindingStopsWhenKubectlFails(t *testing.T) {
	for _, tc := range []struct{ name, script, want string }{
		{"read", `"get rolebinding openclaw-development-automation-observer -n owned-bootstrap --ignore-not-found -o json") exit 31 ;;` + "\n", "read automation observer binding"},
		{"create", `"get rolebinding openclaw-development-automation-observer -n owned-bootstrap --ignore-not-found -o json") exit 0 ;;
"create -f "*) exit 31 ;;` + "\n", "create automation observer binding"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &developmentState{PlatformNamespace: "control-plane", directory: t.TempDir()}
			fakeEngine(t, "kubectl", tc.script)
			r := newRunner(Options{})
			err := r.installDevelopmentAutomationObserver(context.Background(), state, "owned-bootstrap", "ns-owned")
			if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "owned-bootstrap") {
				t.Fatalf("startup did not report the failed tenant binding: %v", err)
			}
		})
	}
}
