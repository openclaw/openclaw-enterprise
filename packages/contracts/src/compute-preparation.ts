import { Type } from "typebox";
import { Check } from "typebox/value";

/** Safe, bounded evidence captured by Compute before retiring failed preparation. */
export interface ComputePreparationFailureEvidence {
  readonly workload: {
    readonly kind: string;
    readonly name: string;
    readonly uid: string;
    readonly namespace: string;
  };
  readonly reason: "retry_limit" | "deadline" | "unknown";
  readonly observedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly pods: readonly {
    readonly name: string;
    readonly uid: string;
    readonly phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
    readonly scheduling: "pending" | "scheduled" | "unschedulable" | "unknown";
    readonly containers: readonly {
      readonly name: string;
      readonly kind: "init" | "main";
      readonly state: "waiting" | "running" | "terminated" | "unknown";
      readonly reason: string | null;
      readonly exitCode: number | null;
      readonly startedAt: string | null;
      readonly finishedAt: string | null;
    }[];
  }[];
}

const Identifier = Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9._-]+$" });
const Time = Type.Union([
  Type.String({
    pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?Z$",
  }),
  Type.Null(),
]);
const Reason = Type.Union([
  Type.Null(),
  ...[
    "Completed",
    "Error",
    "OOMKilled",
    "ContainerCannotRun",
    "StartError",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
    "ContainerCreating",
    "PodInitializing",
  ].map((reason) => Type.Literal(reason)),
]);
export const ComputePreparationFailureEvidenceSchema = Type.Object(
  {
    workload: Type.Object(
      { kind: Identifier, name: Identifier, uid: Identifier, namespace: Identifier },
      { additionalProperties: false },
    ),
    reason: Type.Union([
      Type.Literal("retry_limit"),
      Type.Literal("deadline"),
      Type.Literal("unknown"),
    ]),
    observedAt: Type.String({
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?Z$",
    }),
    startedAt: Time,
    finishedAt: Time,
    pods: Type.Array(
      Type.Object(
        {
          name: Identifier,
          uid: Identifier,
          phase: Type.Union(
            ["Pending", "Running", "Succeeded", "Failed", "Unknown"].map((phase) =>
              Type.Literal(phase),
            ),
          ),
          scheduling: Type.Union(
            ["pending", "scheduled", "unschedulable", "unknown"].map((state) =>
              Type.Literal(state),
            ),
          ),
          containers: Type.Array(
            Type.Object(
              {
                name: Identifier,
                kind: Type.Union([Type.Literal("init"), Type.Literal("main")]),
                state: Type.Union(
                  ["waiting", "running", "terminated", "unknown"].map((state) =>
                    Type.Literal(state),
                  ),
                ),
                reason: Reason,
                exitCode: Type.Union([
                  Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
                  Type.Null(),
                ]),
                startedAt: Time,
                finishedAt: Time,
              },
              { additionalProperties: false },
            ),
            { maxItems: 16 },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 4 },
    ),
  },
  { additionalProperties: false },
);

/** Reject arbitrary provider/process fields before they enter durable public evidence. */
export function isComputePreparationFailureEvidence(
  value: unknown,
): value is ComputePreparationFailureEvidence {
  return Check(ComputePreparationFailureEvidenceSchema, value);
}
