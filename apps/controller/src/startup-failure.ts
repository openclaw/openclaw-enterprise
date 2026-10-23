import { configurationLogDetails } from "./logging.ts";
import { ConfigurationValidationError } from "@openclaw-enterprise/contracts";
import { PostgresCertificateRejectedError } from "@openclaw-enterprise/occ";
import { KubernetesApiUnavailableError } from "./drivers/kubernetes/client.ts";
import {
  ChartListenerMismatchError,
  InstallationFieldError,
} from "./composition/installation-fields.ts";

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

/**
 * Log fields for an Installation listener the chart cannot reach: the code and one detail
 * whose message names the Installation and Helm settings and values (ports, a bind host or
 * a flag; never a file path or secret).
 */
export function startupListenerFailure(error: unknown) {
  return error instanceof ChartListenerMismatchError
    ? {
        code: error.code,
        details: [{ path: error.path, code: "INVALID_VALUE" as const, message: error.message }],
      }
    : undefined;
}

/**
 * Shared configuration failures contain only bounded, schema-owned diagnostics. Installation
 * field refusals (an authority block, finding 2216) use the same code and detail shape.
 */
export function startupConfigurationFailure(error: unknown) {
  return error instanceof ConfigurationValidationError
    ? { code: "DRIVER_CONFIGURATION_INVALID", details: error.error.details }
    : error instanceof InstallationFieldError
      ? { code: "DRIVER_CONFIGURATION_INVALID", details: error.details }
      : undefined;
}

/** One-line operator diagnostics, with the same safe fields as API and worker logs. */
export function formatStartupConfigurationFailure(error: unknown): string | undefined {
  const failure = startupConfigurationFailure(error);
  return failure === undefined
    ? undefined
    : `${failure.code}: ${JSON.stringify(configurationLogDetails(failure.details))}`;
}
