// Shared Installation value validation. File loading, environment access and
// Driver binding remain in their owning composition modules.
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";
import type { KubernetesGatewayRoutingOptions } from "../drivers/compute/kubernetes/index.ts";

export type ConfigurationRecord = Readonly<Record<string, unknown>>;

export function object(value: unknown, path: string): ConfigurationRecord {
  const result = asRecord(value);
  if (result === undefined) {
    throw new Error(`${path} must be one object.`);
  }
  return result;
}

export function closed(value: ConfigurationRecord, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`${path} contains unsupported option ${key}.`);
    }
  }
}

export function nonempty(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a nonempty string.`);
  }
  return value;
}

export interface TlsListenerConfiguration {
  readonly host: string;
  readonly port: number;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly issuerPublicKeyPath: string;
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
}

/** A dotted Installation setting as the JSON Pointer that startup diagnostics carry. */
function settingPointer(setting: string): string {
  return setting === ""
    ? ""
    : "/" +
        setting
          .split(".")
          .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
          .join("/");
}

export interface InstallationFieldDetail {
  readonly path: string;
  readonly code:
    | "REQUIRED"
    | "UNKNOWN_FIELD"
    | "INVALID_TYPE"
    | "INVALID_FORMAT"
    | "INVALID_RANGE"
    | "INVALID_VALUE";
  readonly message: string;
}

/**
 * Refused Installation fields. Each detail holds the field's JSON Pointer, a schema error code
 * and a message that names the field, never its value. Startup logs these details and the
 * chart's upgrade check prints them, as for Driver configuration.
 */
export class InstallationFieldError extends Error {
  override readonly name = "InstallationFieldError";
  readonly details: readonly [InstallationFieldDetail, ...InstallationFieldDetail[]];
  constructor(details: readonly [InstallationFieldDetail, ...InstallationFieldDetail[]]) {
    // The same bound as ConfigurationValidationError and the startup log filter.
    const bounded = details.slice(0, 32) as [InstallationFieldDetail, ...InstallationFieldDetail[]];
    super(bounded.map((detail) => detail.message).join(" "));
    this.details = bounded;
  }
}

const tlsListenerFiles = ["certificatePath", "privateKeyPath", "issuerPublicKeyPath"];
const tlsListenerFields = [
  "host",
  "port",
  ...tlsListenerFiles,
  "issuer",
  "audience",
  "keyId",
] as const;

/**
 * Validate one TLS and issuer listener block. Each fault names its own field and never echoes a value,
 * so startup logs and the chart's upgrade check say which key to fix (finding 2216).
 */
export function tlsListenerConfiguration(
  input: unknown,
  mode: "development" | "production",
  path: string,
): TlsListenerConfiguration {
  const pointer = (field?: string) =>
    settingPointer(field === undefined ? path : `${path}.${field}`);
  const value = asRecord(input);
  if (!value) {
    throw new InstallationFieldError([
      {
        path: pointer(),
        code: input === undefined ? "REQUIRED" : "INVALID_TYPE",
        message: `${path} must be one object.`,
      },
    ]);
  }
  const details: InstallationFieldDetail[] = [];
  // The block's own pointer: an operator's key may be long, contain control characters or
  // look like a credential, and the log filter would drop a detail that echoed it.
  if (Object.keys(value).some((key) => !(tlsListenerFields as readonly string[]).includes(key))) {
    details.push({
      path: pointer(),
      code: "UNKNOWN_FIELD",
      message: `${path} supports only ${tlsListenerFields.join(", ")}.`,
    });
  }
  for (const field of tlsListenerFields) {
    const entry = value[field];
    if (field === "port") {
      if (
        entry === undefined ||
        !Number.isSafeInteger(entry) ||
        Number(entry) < 1 ||
        Number(entry) > 65535
      ) {
        details.push({
          path: pointer(field),
          code:
            entry === undefined
              ? "REQUIRED"
              : Number.isSafeInteger(entry)
                ? "INVALID_RANGE"
                : "INVALID_TYPE",
          message: `${path}.port must be an integer TCP port from 1 to 65535.`,
        });
      }
    } else if (typeof entry !== "string" || !entry) {
      details.push({
        path: pointer(field),
        code: entry === undefined ? "REQUIRED" : entry === "" ? "INVALID_VALUE" : "INVALID_TYPE",
        message: `${path}.${field} must be a nonempty string.`,
      });
    } else if (tlsListenerFiles.includes(field) && !isAbsolute(entry)) {
      details.push({
        path: pointer(field),
        code: "INVALID_FORMAT",
        message: `${path}.${field} must be an absolute mounted-file path.`,
      });
    } else if (
      field === "host" &&
      mode === "development" &&
      !["127.0.0.1", "::1"].includes(entry)
    ) {
      details.push({
        path: pointer(field),
        code: "INVALID_VALUE",
        message: `${path}.host must be 127.0.0.1 or ::1 in development, a loopback listener.`,
      });
    }
  }
  const [first, ...rest] = details;
  if (first) {
    throw new InstallationFieldError([first, ...rest]);
  }
  return value as unknown as TlsListenerConfiguration;
}

/**
 * The Installation's private Gateway routing differs from the chart's resource or listener.
 * Startup and the chart's upgrade check report it as `CHART_LISTENER_MISMATCH`.
 * The message names the Installation and Helm settings and values, which hold no secret;
 * `path` is the refused Installation setting as a JSON Pointer (finding 2213).
 */
export class ChartListenerMismatchError extends Error {
  override readonly name = "ChartListenerMismatchError";
  readonly code = "CHART_LISTENER_MISMATCH";
  readonly path: string;
  constructor(message: string, setting: string) {
    super(message);
    this.path = settingPointer(setting);
  }
}

/** Compare selected Kubernetes routing with the private Gateway this chart renders. */
export function requireChartGatewayRouting(
  routing: KubernetesGatewayRoutingOptions | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const encoded = environment.OCC_CHART_GATEWAY_ROUTING;
  // Direct routing and Gateways managed outside this chart have no chart-owned expectation.
  if (encoded === undefined || routing === undefined) {
    return;
  }
  const path = "drivers.compute.configuration.gatewayRouting";
  let declared: ConfigurationRecord | undefined;
  try {
    declared = asRecord(JSON.parse(encoded));
  } catch {
    // Report only the chart-owned setting, never the submitted JSON.
  }
  if (
    declared === undefined ||
    ["gatewayName", "gatewayNamespace", "envoyNamespace", "hostname", "defaultHostname"].some(
      (field) => !isNonEmptyString(declared?.[field]),
    )
  ) {
    throw new ChartListenerMismatchError(
      "OCC_CHART_GATEWAY_ROUTING must contain the private Gateway expectation rendered by the Helm chart.",
      path,
    );
  }
  for (const [field, chart] of [
    ["gatewayName", "Helm gatewayRouting.gatewayName"],
    ["gatewayNamespace", "the Helm release namespace"],
    ["envoyNamespace", "Helm gatewayRouting.envoyNamespace"],
  ] as const) {
    if (routing[field] !== declared[field]) {
      throw new ChartListenerMismatchError(
        `${path}.${field} must match ${chart}.`,
        `${path}.${field}`,
      );
    }
  }
  // Matching resource identities give Compute the same automatic Service DNS as the chart.
  // Keep the chart's existing derivation as the source for both its listener and this check.
  if ((routing.hostname || declared.defaultHostname) !== declared.hostname) {
    throw new ChartListenerMismatchError(
      `${path}.hostname must match Helm gatewayRouting.hostname. Set both to the same DNS name, or omit both for automatic Service DNS.`,
      `${path}.hostname`,
    );
  }
}
