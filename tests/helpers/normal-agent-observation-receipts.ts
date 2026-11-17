import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const Strings = Type.Array(Type.String());
const ExitCode = Type.Optional(Type.Union([Type.Number(), Type.Null()]));
const OptionalString = Type.Optional(Type.String());
const OptionalFlag = Type.Optional(Type.Boolean());

const GatewayCall = Type.Object({
  seq: Type.Number(),
  id: OptionalString,
  name: Type.String(),
  mirrorIdentity: OptionalString,
  processAction: OptionalString,
  processSessionId: OptionalString,
  operations: Type.Optional(Strings),
});

const GatewayResult = Type.Object({
  seq: Type.Number(),
  toolCallId: OptionalString,
  mirrorIdentity: OptionalString,
  status: OptionalString,
  isError: Type.Boolean(),
  matchesResult: Type.Boolean(),
  exitCode: ExitCode,
  processSessionId: OptionalString,
  commitShas: Type.Optional(Strings),
  pullUrls: Type.Optional(Strings),
});

const GatewayReceipt = Type.Object({
  exists: Type.Boolean(),
  sessionId: OptionalString,
  messageCount: Type.Optional(Type.Number()),
  userMarkerSeen: OptionalFlag,
  assistantMarkerSeen: OptionalFlag,
  terminalAssistantMarkerSeen: OptionalFlag,
  assistantError: OptionalFlag,
  promptReportSource: Type.Optional(Type.Unknown()),
  promptToolNames: Type.Optional(Strings),
  calls: Type.Optional(Type.Array(GatewayCall)),
  results: Type.Optional(Type.Array(GatewayResult)),
  codexTurns: Type.Optional(
    Type.Array(
      Type.Object({
        turnPrefix: Type.String(),
        promptSeen: Type.Boolean(),
        terminalAssistantSeen: Type.Boolean(),
        terminalAssistantDelivered: Type.Boolean(),
        toolCallMirrorSeen: Type.Boolean(),
        toolResultMirrorSeen: Type.Boolean(),
      }),
    ),
  ),
  diagnostics: Type.Optional(
    Type.Object({
      eventCount: Type.Number(),
      roleCounts: Type.Record(Type.String(), Type.Number()),
      observedToolNames: Strings,
      finalAssistantDiagnostics: Type.Object({ mentionsUnavailable: Type.Boolean() }),
    }),
  ),
});

export type NativeCommand = Static<typeof NativeCommand>;
const NativeCommand = Type.Object({
  id: OptionalString,
  status: OptionalString,
  exitCode: ExitCode,
  operations: Strings,
  http400: Type.Boolean(),
  pushRefRefused: Type.Boolean(),
  sandboxDenied: Type.Boolean(),
  failureCategories: Strings,
  commitShas: Strings,
  pullUrls: Strings,
});

const NativeReceipt = Type.Object({
  status: OptionalString,
  cwdMatchesExpectedWorkspace: OptionalFlag,
  turnId: OptionalString,
  threadId: OptionalString,
  rolloutPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  commands: Type.Array(NativeCommand),
  observerStage: OptionalString,
  observerReason: OptionalString,
  failure: Type.Optional(Type.Unknown()),
});

const PolicyReceipt = Type.Object({
  evidenceKind: Type.Literal("diagnostic-only"),
  observerStage: Type.String(),
  available: Type.Boolean(),
});

const FailureReceipt = Type.Object({
  exists: Type.Boolean(),
  toolResults: Type.Optional(Type.Array(Type.Object({ seq: Type.Number(), categories: Strings }))),
});

// Check fields that the acceptance callers consume. Additional observer metadata
// stays in the receipt, and a missing session or omitted optional field is valid.
export function parseGatewayObservation(text: string) {
  const value: unknown = JSON.parse(text);
  if (!Check(GatewayReceipt, value)) {
    throw new Error("invalid Gateway session evidence");
  }
  return value;
}

export function parseNativeObservation(text: string) {
  const value: unknown = JSON.parse(text);
  if (!Check(NativeReceipt, value)) {
    throw new Error("invalid native command evidence");
  }
  return value;
}

export function parseNativePolicyObservation(text: string) {
  const value: unknown = JSON.parse(text);
  if (!Check(PolicyReceipt, value)) {
    throw new Error("invalid native policy evidence");
  }
  return value;
}

export function parseRepositoryFailureObservation(text: string) {
  const value: unknown = JSON.parse(text);
  if (!Check(FailureReceipt, value)) {
    throw new Error("invalid repository failure evidence");
  }
  return value;
}
