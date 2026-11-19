import { createHash } from "node:crypto";
import { asRecord } from "@openclaw-enterprise/utils";

const empty = Buffer.alloc(0);

function unsigned(value: number): Buffer {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function scalar(field: number, value = 0, present = value !== 0): Buffer {
  return present ? Buffer.concat([unsigned(field * 8), unsigned(value)]) : empty;
}

function message(field: number, value: Buffer): Buffer {
  return Buffer.concat([unsigned(field * 8 + 2), unsigned(value.length), value]);
}

function text(field: number, value: unknown, repeated = false): Buffer {
  if (value === undefined) {
    return empty;
  }
  if (typeof value !== "string") {
    throw new TypeError("Expected a policy string");
  }
  return value || repeated ? message(field, Buffer.from(value)) : empty;
}

function size(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function framed(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([size(bytes.length), bytes]);
}

function fields(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = asRecord(value);
  if (!record || Object.keys(record).some((key) => !keys.includes(key))) {
    throw new TypeError("Unsupported OpenShell Provider policy fields");
  }
  return record;
}

function list(value: unknown): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Expected an OpenShell Provider policy list");
  }
  return value;
}

function enumValue(value: unknown, prefix: string, variants: readonly string[]): number {
  if (value === undefined) {
    return 0;
  }
  const index =
    typeof value === "string" && value.startsWith(prefix)
      ? variants.indexOf(value.slice(prefix.length))
      : -1;
  if (index < 0) {
    throw new TypeError("Unsupported OpenShell Provider policy enum");
  }
  return index;
}

function queryMap(value: unknown, label: string): Buffer {
  const query = value === undefined ? {} : asRecord(value);
  if (!query) {
    throw new TypeError("Expected an OpenShell Provider policy matcher map");
  }
  const entries = Object.entries(query)
    .map(([key, matcher]) => ({ key: Buffer.from(key), matcher: fields(matcher, ["glob", "any"]) }))
    .sort((left, right) => Buffer.compare(left.key, right.key));
  return Buffer.concat([
    framed(label),
    size(entries.length),
    ...entries.flatMap(({ key, matcher }) => [
      framed(key),
      framed(
        Buffer.concat([
          text(1, matcher.glob),
          ...list(matcher.any).map((item) => text(2, item, true)),
        ]),
      ),
    ]),
  ]);
}

function endpointAuthority(
  value: unknown,
  index: number,
): { readonly bytes: Buffer; readonly maps: Buffer } {
  const endpoint = fields(value, [
    "host",
    "port",
    "protocol",
    "tls",
    "enforcement",
    "access",
    "rules",
    "path",
    "mcp",
    "provider_credentialed",
    "token_grant_owner",
  ]);
  const { port, mcp } = endpoint;
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw new TypeError("Expected an OpenShell Provider endpoint port");
  }
  const rules = list(endpoint.rules).map((value) => {
    const { allow } = fields(value, ["allow"]);
    if (allow === undefined) {
      return { bytes: message(7, empty), maps: empty };
    }
    const rule = fields(allow, ["method", "path", "query", "params"]);
    return {
      bytes: message(7, message(1, Buffer.concat([text(1, rule.method), text(2, rule.path)]))),
      maps: Buffer.concat([
        queryMap(rule.query, "allow_query"),
        queryMap(rule.params, "allow_params"),
      ]),
    };
  });
  let mcpBytes: Buffer = empty;
  if (mcp !== undefined) {
    const options = fields(mcp, ["strict_tool_names", "allow_all_known_mcp_methods", "versions"]);
    const flags = [options.strict_tool_names, options.allow_all_known_mcp_methods];
    if (flags.some((flag) => flag !== undefined && typeof flag !== "boolean")) {
      throw new TypeError("Expected OpenShell MCP policy booleans");
    }
    mcpBytes = message(
      23,
      Buffer.concat([
        ...flags.map((flag, index) => scalar(index + 1, Number(flag === true), flag !== undefined)),
        ...list(options.versions).map((version) => text(3, version, true)),
      ]),
    );
  }
  return {
    bytes: message(
      2,
      Buffer.concat([
        text(1, endpoint.host),
        scalar(2, port),
        text(3, endpoint.protocol),
        scalar(
          4,
          enumValue(endpoint.tls, "NETWORK_TLS_MODE_", [
            "UNSPECIFIED",
            "SKIP",
            "TERMINATE",
            "PASSTHROUGH",
          ]),
        ),
        scalar(
          5,
          enumValue(endpoint.enforcement, "NETWORK_ENFORCEMENT_MODE_", [
            "UNSPECIFIED",
            "ENFORCE",
            "AUDIT",
          ]),
        ),
        scalar(
          6,
          enumValue(endpoint.access, "NETWORK_ACCESS_PRESET_", [
            "UNSPECIFIED",
            "READ_ONLY",
            "READ_WRITE",
            "FULL",
          ]),
        ),
        ...rules.map(({ bytes }) => bytes),
        text(15, endpoint.path),
        mcpBytes,
      ]),
    ),
    maps: Buffer.concat([
      size(index),
      framed("graphql_persisted_queries"),
      size(0),
      ...rules.flatMap(({ maps }, index) => [size(index), maps]),
    ]),
  };
}

/** OpenShell 0.1.8 policy_identity.rs uses a map-free protobuf rule followed by
 * its ordered map entries. Refuse fields outside the supported Provider policy
 * subset because omitting them could equate distinct grant authorities. */
export function openShellProviderTokenGrantOwners(
  providerId: string,
  rule: { readonly endpoints: readonly unknown[]; readonly binaries: readonly unknown[] },
): string[] | undefined {
  try {
    const endpoints = rule.endpoints.map(endpointAuthority);
    const binaries = rule.binaries.map((binary) =>
      message(3, text(1, fields(binary, ["path"]).path)),
    );
    const canonical = Buffer.concat([
      framed(Buffer.concat([...endpoints.map(({ bytes }) => bytes), ...binaries])),
      ...endpoints.map(({ maps }) => maps),
    ]);
    return endpoints.map((_, index) => {
      const hash = createHash("sha256")
        .update(framed("openshell:provider-token-grant-owner:v1"))
        .update(framed(providerId))
        .update(framed(canonical))
        .update(size(index))
        .digest("hex");
      return `grant-owner:v1:${hash}`;
    });
  } catch {
    return undefined;
  }
}

export function withOpenShellProviderTokenGrantOwners<
  Rule extends {
    readonly endpoints: readonly Record<string, unknown>[];
    readonly binaries: readonly unknown[];
  },
>(rule: Rule, providerId: string | undefined) {
  // Files-only profiles have no endpoint whose token-grant authority can change.
  if (rule.endpoints.length === 0) {
    return rule;
  }
  if (typeof providerId !== "string" || !providerId) {
    return undefined;
  }
  const owners = openShellProviderTokenGrantOwners(providerId, rule);
  if (!owners) {
    return undefined;
  }
  return {
    ...rule,
    endpoints: rule.endpoints.map((endpoint, index) => ({
      ...endpoint,
      token_grant_owner: owners[index],
    })),
  };
}
