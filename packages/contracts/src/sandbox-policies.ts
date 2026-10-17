import { Type } from "typebox";
import { Check } from "typebox/value";

export interface SandboxNetworkPolicyRule {
  readonly id: string;
  readonly name: string;
  readonly origin: "configured" | "provider" | "builtin";
  readonly binaries: readonly string[];
  readonly destinations: readonly {
    readonly host: string;
    readonly ports: readonly number[];
    readonly protocol: string;
    readonly tls: string;
    readonly enforcement: string;
    readonly access?: string;
  }[];
  /** Driver-owned network conditions, with credential-shaped literals redacted. */
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface SandboxNetworkPolicyDescription {
  readonly sandbox: string;
  readonly observedAt: string;
  readonly identity: {
    readonly source: string;
    readonly version: number;
    readonly globalVersion?: number;
    readonly policyHash: string;
    readonly configRevision: string;
    readonly providerEnvRevision: string;
  };
  readonly admission: {
    /** Applied requires evidence that the runtime loaded this exact effective snapshot. */
    readonly state: "applied" | "pending" | "rejected" | "unknown";
    readonly policyHash?: string;
    readonly configRevision?: string;
    readonly providerEnvRevision?: string;
    readonly instanceId?: string;
  };
  readonly rules: readonly SandboxNetworkPolicyRule[];
}

export interface SandboxNetworkPolicyRequest {
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
  readonly expectedPolicyHash: string;
}

export type SandboxPolicyDecision = "allow" | "deny" | "audit" | "unknown";

export interface SandboxNetworkPolicyEvaluation {
  readonly policyHash: string;
  readonly applied: boolean;
  readonly decision: SandboxPolicyDecision;
  readonly reason: string;
  readonly rules: readonly {
    readonly id: string;
    readonly matched: boolean;
    readonly reason: string;
  }[];
  readonly stages: readonly {
    readonly id: string;
    readonly decision: SandboxPolicyDecision;
    readonly reason: string;
  }[];
  readonly unevaluatedChecks: readonly string[];
}

const text = Type.String({ maxLength: 4096 });
const identifier = Type.String({ minLength: 1, maxLength: 256 });
const ruleId = Type.String({ minLength: 1, maxLength: 512 });
const fingerprint = Type.String({ pattern: "^[0-9]+$", maxLength: 20 });
const policyHash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const path = Type.String({ pattern: "^/", maxLength: 4096 });
const decision = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("audit"),
  Type.Literal("unknown"),
]);

export const SandboxNetworkPolicyRequestSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253, pattern: "^[^\\s/:?#]+$" }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    binaryPath: path,
    binarySha256: Type.Optional(policyHash),
    ancestors: Type.Optional(Type.Array(path, { maxItems: 64 })),
    cmdlinePaths: Type.Optional(Type.Array(path, { maxItems: 64 })),
    http: Type.Optional(
      Type.Object(
        {
          method: Type.String({ pattern: "^[A-Z]{1,16}$" }),
          path,
          query: Type.Optional(
            Type.Record(Type.String({ maxLength: 256 }), Type.Array(text, { maxItems: 32 }), {
              maxProperties: 64,
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    expectedPolicyHash: policyHash,
  },
  { additionalProperties: false },
);

export const SandboxNetworkPolicyDescriptionSchema = Type.Object(
  {
    sandbox: identifier,
    observedAt: Type.String({ format: "date-time" }),
    identity: Type.Object(
      {
        source: identifier,
        version: Type.Integer({ minimum: 0 }),
        globalVersion: Type.Optional(Type.Integer({ minimum: 0 })),
        policyHash,
        configRevision: fingerprint,
        providerEnvRevision: fingerprint,
      },
      { additionalProperties: false },
    ),
    admission: Type.Object(
      {
        state: Type.Union([
          Type.Literal("applied"),
          Type.Literal("pending"),
          Type.Literal("rejected"),
          Type.Literal("unknown"),
        ]),
        policyHash: Type.Optional(policyHash),
        configRevision: Type.Optional(fingerprint),
        providerEnvRevision: Type.Optional(fingerprint),
        instanceId: Type.Optional(identifier),
      },
      { additionalProperties: false },
    ),
    rules: Type.Array(
      Type.Object(
        {
          id: ruleId,
          name: identifier,
          origin: Type.Union([
            Type.Literal("configured"),
            Type.Literal("provider"),
            Type.Literal("builtin"),
          ]),
          binaries: Type.Array(text, { maxItems: 256 }),
          destinations: Type.Array(
            Type.Object(
              {
                host: text,
                ports: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 256 }),
                protocol: text,
                tls: text,
                enforcement: text,
                access: Type.Optional(text),
              },
              { additionalProperties: false },
            ),
            { maxItems: 256 },
          ),
          configuration: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1024 },
    ),
  },
  { additionalProperties: false },
);

export const SandboxNetworkPolicyEvaluationSchema = Type.Object(
  {
    policyHash,
    applied: Type.Boolean(),
    decision,
    reason: text,
    rules: Type.Array(
      Type.Object(
        { id: ruleId, matched: Type.Boolean(), reason: text },
        { additionalProperties: false },
      ),
      { maxItems: 1024 },
    ),
    stages: Type.Array(
      Type.Object({ id: identifier, decision, reason: text }, { additionalProperties: false }),
      { maxItems: 32 },
    ),
    unevaluatedChecks: Type.Array(text, { maxItems: 32 }),
  },
  { additionalProperties: false },
);

export function isSandboxNetworkPolicyRequest(
  value: unknown,
): value is SandboxNetworkPolicyRequest {
  return Check(SandboxNetworkPolicyRequestSchema, value);
}

export function isSandboxNetworkPolicyDescription(
  value: unknown,
): value is SandboxNetworkPolicyDescription {
  return Check(SandboxNetworkPolicyDescriptionSchema, value);
}

export function isSandboxNetworkPolicyEvaluation(
  value: unknown,
): value is SandboxNetworkPolicyEvaluation {
  return Check(SandboxNetworkPolicyEvaluationSchema, value);
}
