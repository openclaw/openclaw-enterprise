import { Type } from "typebox";
import { Check } from "typebox/value";
import type { PluginDesiredState, PluginPolicyCapabilities } from "./index.ts";
import { SandboxNetworkPolicyRequestSchema } from "./sandbox-policies.ts";

export interface NetworkSimulationPolicy {
  readonly kind: "network";
  readonly source?: "driver_configuration" | "revision";
  readonly rules: readonly {
    readonly id: string;
    readonly name: string;
    readonly binaries: readonly string[];
    readonly destinations: readonly {
      readonly host: string;
      readonly ports: readonly number[];
      readonly http?: {
        readonly methods: readonly string[];
        readonly enforcement: "enforce" | "audit";
      };
      readonly unsupportedReason?: string;
    }[];
    readonly unsupportedReason?: string;
  }[];
  readonly unevaluatedChecks: readonly string[];
}

export interface PluginSimulationPolicy {
  readonly kind: "plugin";
  readonly plugins: PluginDesiredState;
  readonly capabilities: PluginPolicyCapabilities;
  /** Null means that the Driver has no verified inventory for this plugin. */
  readonly toolIds: Readonly<Record<string, readonly string[] | null>>;
  readonly unevaluatedChecks: readonly string[];
}

export type PolicySimulationPolicy = NetworkSimulationPolicy | PluginSimulationPolicy;
export interface PolicySimulationDescription {
  readonly revisionId: string;
  readonly network?: { readonly simulationHash: string; readonly policy: NetworkSimulationPolicy };
  readonly plugins?: { readonly simulationHash: string; readonly policy: PluginSimulationPolicy };
  readonly unsupported: readonly { readonly kind: "network" | "plugin"; readonly reason: string }[];
}
export type PolicySimulationDecision = "allow" | "deny" | "audit" | "approval_required" | "unknown";
export interface PolicySimulationResult {
  readonly decision: PolicySimulationDecision;
  readonly reason: string;
  readonly rules: readonly {
    readonly id: string;
    readonly name: string;
    readonly matched: boolean;
    readonly decision: PolicySimulationDecision;
    readonly reason: string;
  }[];
  readonly unevaluatedChecks: readonly string[];
}

export type PolicySimulationRequest =
  | {
      readonly kind: "network";
      readonly host: string;
      readonly port: number;
      readonly binaryPath: string;
      readonly binarySha256?: string;
      readonly ancestors?: readonly string[];
      readonly cmdlinePaths?: readonly string[];
      readonly http?: {
        readonly method: string;
        readonly path: string;
        readonly query?: Readonly<Record<string, readonly string[]>>;
      };
      readonly expectedSimulationHash: string;
    }
  | {
      readonly kind: "plugin";
      readonly pluginId: string;
      readonly toolId: string;
      /** Hypothetical action metadata, not verified runtime annotations. */
      readonly readOnly?: boolean;
      readonly destructive?: boolean;
      readonly expectedSimulationHash: string;
    };

const text = Type.String({ maxLength: 4096 });
const id = Type.String({ minLength: 1, maxLength: 512 });
const traceId = Type.String({ minLength: 1, maxLength: 1024 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const checks = Type.Array(text, { maxItems: 64 });
const decision = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("audit"),
  Type.Literal("approval_required"),
  Type.Literal("unknown"),
]);
const networkProperties = { ...SandboxNetworkPolicyRequestSchema.properties };
delete (networkProperties as Record<string, unknown>).expectedPolicyHash;

export const PolicySimulationRequestSchema = Type.Union([
  Type.Object(
    { ...networkProperties, kind: Type.Literal("network"), expectedSimulationHash: hash },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("plugin"),
      pluginId: id,
      toolId: id,
      readOnly: Type.Optional(Type.Boolean()),
      destructive: Type.Optional(Type.Boolean()),
      expectedSimulationHash: hash,
    },
    { additionalProperties: false },
  ),
]);
export const NetworkSimulationPolicySchema = Type.Object(
  {
    kind: Type.Literal("network"),
    source: Type.Optional(
      Type.Union([Type.Literal("driver_configuration"), Type.Literal("revision")]),
    ),
    rules: Type.Array(
      Type.Object(
        {
          id,
          name: id,
          binaries: Type.Array(text, { maxItems: 256 }),
          destinations: Type.Array(
            Type.Object(
              {
                host: text,
                ports: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 256 }),
                http: Type.Optional(
                  Type.Object(
                    {
                      methods: Type.Array(Type.String({ pattern: "^(?:[A-Z]{1,16}|[*])$" }), {
                        maxItems: 32,
                      }),
                      enforcement: Type.Union([Type.Literal("enforce"), Type.Literal("audit")]),
                    },
                    { additionalProperties: false },
                  ),
                ),
                unsupportedReason: Type.Optional(text),
              },
              { additionalProperties: false },
            ),
            { maxItems: 256 },
          ),
          unsupportedReason: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1024 },
    ),
    unevaluatedChecks: checks,
  },
  { additionalProperties: false },
);
const approval = Type.Union([
  Type.Literal("provider_default"),
  Type.Literal("none"),
  Type.Literal("all_actions"),
  Type.Literal("write_actions"),
]);
const reviewer = Type.Union([Type.Literal("human"), Type.Literal("auto")]);
const tool = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    approval: Type.Optional(approval),
    reviewer: Type.Optional(reviewer),
    approvers: Type.Optional(
      Type.Array(Type.Object({ channel: id, id }, { additionalProperties: false }), {
        maxItems: 64,
      }),
    ),
  },
  { additionalProperties: false },
);
const support = Type.Object(
  {
    enabled: Type.Boolean(),
    approval: Type.Array(approval, { maxItems: 4 }),
    reviewer: Type.Array(reviewer, { maxItems: 2 }),
  },
  { additionalProperties: false },
);
export const PluginSimulationPolicySchema = Type.Object(
  {
    kind: Type.Literal("plugin"),
    plugins: Type.Record(
      id,
      Type.Object(
        {
          enabled: Type.Boolean(),
          approvers: Type.Optional(tool.properties.approvers),
          toolDefaults: Type.Optional(
            Type.Object(
              {
                enabled: tool.properties.enabled,
                approval: tool.properties.approval,
                reviewer: tool.properties.reviewer,
              },
              { additionalProperties: false },
            ),
          ),
          tools: Type.Optional(Type.Record(id, tool)),
          driverPolicy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: false },
      ),
      { maxProperties: 256 },
    ),
    capabilities: Type.Object(
      {
        approvers: Type.Optional(
          Type.Object(
            { agent: Type.Boolean(), plugin: Type.Boolean(), tools: Type.Boolean() },
            { additionalProperties: false },
          ),
        ),
        toolDefaults: support,
        tools: support,
        driverPolicySchema: Type.Record(Type.String(), Type.Unknown()),
      },
      { additionalProperties: false },
    ),
    toolIds: Type.Record(id, Type.Union([Type.Array(id, { maxItems: 1024 }), Type.Null()]), {
      maxProperties: 256,
    }),
    unevaluatedChecks: checks,
  },
  { additionalProperties: false },
);
export const PolicySimulationResultSchema = Type.Object(
  {
    decision,
    reason: text,
    rules: Type.Array(
      Type.Object(
        { id: traceId, name: id, matched: Type.Boolean(), decision, reason: text },
        { additionalProperties: false },
      ),
      { maxItems: 1026 },
    ),
    unevaluatedChecks: Type.Array(text, { maxItems: 65 }),
  },
  { additionalProperties: false },
);
const snapshot = (
  policy: typeof NetworkSimulationPolicySchema | typeof PluginSimulationPolicySchema,
) => Type.Object({ simulationHash: hash, policy }, { additionalProperties: false });
export const PolicySimulationDescriptionSchema = Type.Object(
  {
    revisionId: id,
    network: Type.Optional(snapshot(NetworkSimulationPolicySchema)),
    plugins: Type.Optional(snapshot(PluginSimulationPolicySchema)),
    unsupported: Type.Array(
      Type.Object(
        { kind: Type.Union([Type.Literal("network"), Type.Literal("plugin")]), reason: text },
        { additionalProperties: false },
      ),
      { maxItems: 2 },
    ),
  },
  { additionalProperties: false },
);
export const AgentPolicySimulationResultSchema = Type.Object(
  {
    ...PolicySimulationResultSchema.properties,
    revisionId: id,
    kind: Type.Union([Type.Literal("network"), Type.Literal("plugin")]),
    simulationHash: hash,
  },
  { additionalProperties: false },
);
export function isPolicySimulationRequest(value: unknown): value is PolicySimulationRequest {
  return Check(PolicySimulationRequestSchema, value);
}
export function isNetworkSimulationPolicy(value: unknown): value is NetworkSimulationPolicy {
  return Check(NetworkSimulationPolicySchema, value);
}
export function isPluginSimulationPolicy(value: unknown): value is PluginSimulationPolicy {
  return Check(PluginSimulationPolicySchema, value);
}
