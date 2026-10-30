package occdev

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestProtectedOpenShellGatewayRenderContract(t *testing.T) {
	state := &developmentState{PlatformNamespace: "oce-system"}
	if os.Getenv("OCC_TEST_OPENSHELL_STOCK_RELEASE") == "1" {
		t.Run("ordinary stock chart preflight", func(t *testing.T) {
			r := newRunner(Options{})
			// Exercise the normal source download, checksum and chart packaging path.
			for _, key := range []string{
				"OCC_DEVELOPMENT_OPENSHELL_HELM_CHART",
				"OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART",
				"OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE",
				"OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE",
				"OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE",
				"OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION",
			} {
				delete(r.env, key)
			}
			images, err := r.selectOpenShellImages("openshell")
			if err != nil {
				t.Fatal(err)
			}
			if err := r.checkProtectedOpenShellChart(context.Background(), state, images); err != nil {
				t.Fatal(err)
			}
		})
	}

	const render = `kind: StatefulSet
metadata: {name: openshell-gateway}
spec:
  template:
    spec:
      volumes:
        - {name: config, configMap: {name: openshell-gateway-config}}
        - {name: ca, configMap: {name: occ-egress-ca, items: [{key: ca.crt, path: public.pem}]}}
      containers:
        - name: openshell-gateway
          args: [--config, /gateway/config.toml]
          volumeMounts:
            - {name: config, mountPath: /gateway/config.toml, subPath: gateway.toml, readOnly: true}
            - {name: ca, mountPath: /trust, readOnly: true}
---
kind: ConfigMap
metadata: {name: openshell-gateway-config}
data:
  gateway.toml: |
    [[openshell.supervisor.middleware]]
    name = "oce-authority"
    grpc_endpoint = "https://openclaw-enterprise-egress-authority.oce-system.svc.cluster.local:9444"
    audience = "oce-egress"
    allow_insecure_transport = false
    tls_ca_cert_path = "/trust/public.pem"
    max_payload_bytes = 4194304
    timeout = "30s"
    binding_policy = "allowlist"
    bindings = ["http_request_pre_credentials"]
`
	if err := verifyProtectedOpenShellChart([]byte(render), state); err != nil {
		t.Fatalf("valid mounted registration: %v", err)
	}
	const args = "args: [--config, /gateway/config.toml]"
	t.Run("equals-form config selection", func(t *testing.T) {
		changed := strings.Replace(render, args, "args: [--config=/gateway/config.toml]", 1)
		if changed == render {
			t.Fatalf("fixture is missing %q", args)
		}
		if err := verifyProtectedOpenShellChart([]byte(changed), state); err != nil {
			t.Fatalf("valid mounted registration: %v", err)
		}
	})
	t.Run("selected config before end of options", func(t *testing.T) {
		changed := strings.Replace(render, args, "args: [--config=/gateway/config.toml, --]", 1)
		if err := verifyProtectedOpenShellChart([]byte(changed), state); err != nil {
			t.Fatalf("valid mounted registration: %v", err)
		}
	})
	t.Run("daemon options with separate values", func(t *testing.T) {
		changed := strings.Replace(render, args, "args: [--config, /gateway/config.toml, --db-url, 'sqlite:///var/lib/openshell/gateway.db', --port, '8080']", 1)
		if err := verifyProtectedOpenShellChart([]byte(changed), state); err != nil {
			t.Fatalf("valid daemon invocation: %v", err)
		}
	})
	// Helm can succeed while silently ignoring security values. Neither an
	// unconsumed registration nor a CA mounted in a sidecar protects the gateway.
	for _, tt := range []struct{ from, to, want string }{
		{"openshell.supervisor.middleware", "unrelated.middleware", "exactly one supervisor middleware"},
		{"transport = false", "transport = true", "secure transport"},
		{`    binding_policy = "allowlist"`, "", "pre-credentials"},
		{`binding_policy = "allowlist"`, `binding_policy = "dynamic"`, "pre-credentials"},
		{`    bindings = ["http_request_pre_credentials"]`, "", "pre-credentials"},
		{`bindings = ["http_request_pre_credentials"]`, `bindings = ["http_response_pre_return"]`, "pre-credentials"},
		{":9444", ":9445", "required HTTPS endpoint"},
		{args, "args: [--config, /other/config]", "must load gateway.toml"},
		{args, "args: [--config=/gateway/config.toml, extra]", "must load gateway.toml"},
		{args, "args: [--config=/gateway/config.toml, config, preflight]", "must load gateway.toml"},
		{args, "args: [--, --config=/gateway/config.toml]", "must load gateway.toml"},
		{args, "args: [--config=/gateway/config.toml, --, --config=/other]", "must load gateway.toml"},
		{args, "args: [--config, /gateway/config.toml, --config, /other/config]", "must load gateway.toml"},
		{args, "args: [--config, /other/config, --config, /gateway/config.toml]", "must load gateway.toml"},
		{args, "args: [--config, /gateway/config.toml, --config=/other/config]", "must load gateway.toml"},
		{args, "args: [--config=/other/config, --config, /gateway/config.toml]", "must load gateway.toml"},
		{args, "args: [--config=/gateway/config.toml, --config=/other/config]", "must load gateway.toml"},
		{args, "args: [--config, /gateway/config.toml, --config=/gateway/config.toml]", "must load gateway.toml"},
		{"name: ca, mountPath:", "name: other, mountPath:", "must mount public ConfigMap"},
		{"key: ca.crt", "key: wrong.crt", "must mount public ConfigMap"},
		{"/trust/public.pem", "/trust/another.pem", "must mount public ConfigMap"},
		{"mountPath: /trust, readOnly: true", "mountPath: /trust, readOnly: false", "must mount public ConfigMap"},
	} {
		t.Run(tt.to, func(t *testing.T) {
			changed := strings.Replace(render, tt.from, tt.to, 1)
			if changed == render {
				t.Fatalf("fixture is missing %q", tt.from)
			}
			if err := verifyProtectedOpenShellChart([]byte(changed), state); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("want %q, got %v", tt.want, err)
			}
		})
	}
}
