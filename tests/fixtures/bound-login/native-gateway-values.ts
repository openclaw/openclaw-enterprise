import assert from "node:assert/strict";

export interface NativeGatewayTls {
  serverSecretName: string;
  clientCaSecretName: string;
  clientTlsSecretName: string;
}

// OpenShell 0.1.5 / bdb956f2: native listener and application identity are separate.
export function nativeGatewayValues(tls: NativeGatewayTls): string[] {
  for (const name of Object.values(tls)) {
    assert.match(name, /^[a-z0-9][a-z0-9-]{0,62}$/);
  }
  return [
    "--set=server.disableTls=false",
    "--set=server.enableLoopbackServiceHttp=false",
    "--set=server.auth.allowUnauthenticatedUsers=false",
    '--set-json=gatewayConfig.openshell\\.gateway.auth={"allow_unauthenticated_users":false}',
    "--set=server.tls.enableMtls=true",
    `--set-string=server.tls.certSecretName=${tls.serverSecretName}`,
    `--set-string=server.tls.clientCaSecretName=${tls.clientCaSecretName}`,
    `--set-string=server.tls.clientTlsSecretName=${tls.clientTlsSecretName}`,
    '--set-json=gatewayConfig.openshell\\.gateway.mtls_auth={"enabled":true,"operator_enabled":false}',
    "--set=server.drivers.kubernetes.resourceAdmission.enabled=true",
  ];
}
