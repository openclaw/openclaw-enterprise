import { PostgresCertificateRejectedError } from "@openclaw-enterprise/occ";
import { KubernetesApiUnavailableError } from "./drivers/kubernetes/client.ts";

/**
 * Log fields for a startup failure caused by an unreachable or untrusted dependency,
 * naming the dependency class in `code`. A Kubernetes API failure adds its address in
 * `host` and `port`; a refused database certificate adds only the TLS error code in
 * `reason`, never the certificate or the connection URL.
 */
export function startupDependencyFailure(
  error: unknown,
):
  | { readonly code: string; readonly host: string; readonly port: number }
  | { readonly code: string; readonly reason: string }
  | undefined {
  if (error instanceof KubernetesApiUnavailableError) {
    return { code: "KUBERNETES_API_UNAVAILABLE", host: error.host, port: error.port };
  }
  if (error instanceof PostgresCertificateRejectedError) {
    return { code: "DATABASE_TLS_CERTIFICATE_INVALID", reason: error.reason };
  }
  return undefined;
}
