// Shared Installation value validation. File loading, environment access and
// Driver binding remain in their owning composition modules.
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";

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

export interface EgressAuthorityConfiguration {
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

const egressAuthorityFiles = ["certificatePath", "privateKeyPath", "issuerPublicKeyPath"];
const egressAuthorityFields = [
  "host",
  "port",
  ...egressAuthorityFiles,
  "issuer",
  "audience",
  "keyId",
] as const;

/**
 * Validate one TLS and issuer listener block, `drivers.credential_proxy.configuration.authority`
 * or `repository.openShell.authority`. Each fault names its own field and never echoes a value,
 * so startup logs and the chart's upgrade check say which key to fix (finding 2216).
 */
export function egressAuthorityConfiguration(
  input: unknown,
  mode: "development" | "production",
  path: string,
): EgressAuthorityConfiguration {
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
  if (
    Object.keys(value).some((key) => !(egressAuthorityFields as readonly string[]).includes(key))
  ) {
    details.push({
      path: pointer(),
      code: "UNKNOWN_FIELD",
      message: `${path} supports only ${egressAuthorityFields.join(", ")}.`,
    });
  }
  for (const field of egressAuthorityFields) {
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
    } else if (egressAuthorityFiles.includes(field) && !isAbsolute(entry)) {
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
  return value as unknown as EgressAuthorityConfiguration;
}

/**
 * An Installation listener that the production chart's Service cannot reach: the chart
 * serves no such listener, serves it on another port, or the listener does not bind all
 * addresses. Startup and the chart's upgrade check report it as `CHART_LISTENER_MISMATCH`.
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

/** The chart routes these listeners and passes each one's port, or `disabled`, to startup. */
export const chartListeners = {
  egressAuthority: {
    path: "drivers.credential_proxy.configuration.authority",
    chart: "egressAuthority",
    variable: "OCC_EGRESS_AUTHORITY_PORT",
  },
  openshellGit: {
    path: "repository.openShell.authority",
    chart: "openshellGit",
    variable: "OCC_OPENSHELL_GIT_PORT",
  },
} as const;

/**
 * Refuse an Installation listener the chart's Service cannot reach. The Service targets the
 * Pod's address, which the Installation cannot name, so the listener must bind all addresses.
 * Without the chart's variable (no chart, for example a test or another packaging) there is
 * nothing to compare.
 */
export function requireChartListener(
  authority: Pick<EgressAuthorityConfiguration, "host" | "port"> | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  listener: (typeof chartListeners)[keyof typeof chartListeners],
): void {
  const declared = environment[listener.variable];
  if (declared === undefined) {
    return;
  }
  if (declared === "disabled") {
    if (authority !== undefined) {
      throw new ChartListenerMismatchError(
        `${listener.path}.port is ${authority.port}, but Helm ${listener.chart}.enabled is false, so no chart Service reaches it.`,
        `${listener.path}.port`,
      );
    }
    return;
  }
  const port = /^[1-9][0-9]{0,4}$/.test(declared) ? Number(declared) : 0;
  if (port < 1 || port > 65535) {
    throw new ChartListenerMismatchError(
      `${listener.variable} must be a TCP port from 1 to 65535 or disabled.`,
      "",
    );
  }
  if (authority === undefined) {
    return;
  }
  if (authority.port !== port) {
    throw new ChartListenerMismatchError(
      `${listener.path}.port is ${authority.port}, but Helm ${listener.chart}.port is ${port}.`,
      `${listener.path}.port`,
    );
  }
  if (authority.host !== "0.0.0.0" && authority.host !== "::") {
    throw new ChartListenerMismatchError(
      `${listener.path}.host is ${authority.host}, but the chart's ${listener.chart} Service on port ${port} reaches only a listener on all addresses: use 0.0.0.0 or ::.`,
      `${listener.path}.host`,
    );
  }
}

export function openShellRepositoryConfiguration(
  input: unknown,
  mode: "development" | "production",
) {
  if (input === undefined) {
    return undefined;
  }
  const value = object(input, "repository.openShell");
  closed(value, ["registrationName", "authority"], "repository.openShell");
  return {
    registrationName: nonempty(value.registrationName, "repository.openShell.registrationName"),
    authority: egressAuthorityConfiguration(
      value.authority,
      mode,
      "repository.openShell.authority",
    ),
  };
}
