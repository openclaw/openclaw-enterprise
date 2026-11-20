import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { OpenShellExpectedProviderRule } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import type { OpenShellProviderProfileEndpoint } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

type GitRule = OpenShellExpectedProviderRule["rule"];

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const wire = require("@grpc/proto-loader").loadSync(
  new URL(
    "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    import.meta.url,
  ).pathname,
  { keepCase: true },
) as Record<string, { serialize?: (value: object) => Buffer }>;

function serialize(message: string, value: object): Buffer {
  const definition = wire["openshell.v1." + message];
  if (typeof definition?.serialize !== "function") {
    throw new Error("Missing OpenShell protobuf message " + message);
  }
  return definition.serialize(value);
}

function size(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(BigInt(value));
  return result;
}

function frame(value: string | Buffer): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([size(bytes.length), bytes]);
}

// The controlled Gateway builds the stock authority with protobuf serialization.
// This fixture covers Git profiles, whose only populated policy maps are allow queries.
export function stockGitPolicy(rule: GitRule, providerId: string) {
  const gitEndpoints: ReadonlyArray<
    GitRule["endpoints"][number] &
      Pick<OpenShellProviderProfileEndpoint, "rules"> & {
        readonly provider_credentialed?: boolean;
      }
  > = rule.endpoints;
  const endpoints = gitEndpoints.map(({ provider_credentialed, rules, ...endpoint }) => ({
    ...endpoint,
    rules: rules?.map(({ allow: { query, ...allow } }) => ({ allow })),
  }));
  const maps = gitEndpoints.flatMap(({ rules }, endpointIndex) => [
    size(endpointIndex),
    frame("graphql_persisted_queries"),
    size(0),
    ...(rules ?? []).flatMap(({ allow }, ruleIndex) => {
      const entries = Object.entries(allow.query ?? {}).sort(([a], [b]) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );
      return [
        size(ruleIndex),
        frame("allow_query"),
        size(entries.length),
        ...entries.flatMap(([key, value]) => [
          frame(key),
          frame(serialize("L7QueryMatcher", value)),
        ]),
        frame("allow_params"),
        size(0),
      ];
    }),
  ]);
  const authority = Buffer.concat([
    frame(serialize("NetworkPolicyRule", { binaries: rule.binaries, endpoints })),
    ...maps,
  ]);
  return {
    ...rule,
    endpoints: rule.endpoints.map((endpoint, index) => ({
      ...endpoint,
      token_grant_owner:
        "grant-owner:v1:" +
        createHash("sha256")
          .update(frame("openshell:provider-token-grant-owner:v1"))
          .update(frame(providerId))
          .update(frame(authority))
          .update(size(index))
          .digest("hex"),
    })),
  };
}
