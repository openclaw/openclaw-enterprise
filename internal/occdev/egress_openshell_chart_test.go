package occdev

import (
	"strings"
	"testing"
)

func TestProtectedOpenShellGatewayRenderContract(t *testing.T) {
	state := &developmentState{PlatformNamespace: "oce-system"}
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
`
	if err := verifyProtectedOpenShellChart([]byte(render), state); err != nil {
		t.Fatalf("valid mounted registration: %v", err)
	}
	// Helm can succeed while silently ignoring security values. Neither an
	// unconsumed registration nor a CA mounted in a sidecar protects the gateway.
	for _, tt := range []struct{ from, to, want string }{
		{"openshell.supervisor.middleware", "unrelated.middleware", "exactly one supervisor middleware"},
		{"transport = false", "transport = true", "secure transport"},
		{":9444", ":9445", "required HTTPS endpoint"},
		{"args: [--config, /gateway/config.toml]", "args: [--config, /other/config]", "must load gateway.toml"},
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
