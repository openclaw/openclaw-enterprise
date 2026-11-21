import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  EgressRef,
  EgressSourceKey,
  StaticMaterialEvidence,
} from "../../packages/contracts/src/index.ts";
import type { SendAttempt } from "../../packages/occ/src/egress-send-receipts.ts";
import type { PlatformStateStore } from "../../packages/occ/src/state/platform-state.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { isRecord, parseJson } from "../helpers/egress-observation-values.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

type DeployedFixture = Extract<
  Awaited<ReturnType<typeof staticEgressFixture>>,
  { fixtureKind: "deployed" }
>;
type StaticSendAttempt = SendAttempt & { readonly material: StaticMaterialEvidence };
type FaultMethod =
  "findCredentialWithdrawal" | "isEgressMaterialRejected" | "insert" | "authorize" | "save";
type FaultKind = "pause" | "reject" | "lost_ack";
type ArmedFault = {
  method: FaultMethod;
  kind: FaultKind;
  reached: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
};

function isRef(value: unknown): value is EgressRef {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function isSourceKey(value: unknown): value is EgressSourceKey {
  return (
    isRecord(value) &&
    typeof value.installationId === "string" &&
    typeof value.namespaceId === "string" &&
    isRef(value.source) &&
    isRef(value.backend) &&
    isRef(value.provider)
  );
}

function isStaticMaterial(value: unknown): value is StaticMaterialEvidence {
  return (
    isRecord(value) &&
    value.kind === "static" &&
    isSourceKey(value.source) &&
    isRef(value.binding) &&
    typeof value.grantHash === "string" &&
    typeof value.isolationId === "string" &&
    value.adoption === "live" &&
    typeof value.materialRefId === "string" &&
    isRecord(value.secret) &&
    value.secret.kind === "secret" &&
    typeof value.secret.namespaceId === "string" &&
    typeof value.secret.id === "string" &&
    isRef(value.secretDriver) &&
    typeof value.materialId === "string" &&
    typeof value.materialVersion === "string" &&
    typeof value.authoritativeObservedAt === "string" &&
    typeof value.usableUntil === "string" &&
    value.retention === "none"
  );
}

export async function stageReceiptExchange(f: DeployedFixture) {
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok(ready, "authority resolved the staged operation");
  const useId = captured.request.context.request_id;
  const material = parseJson(ready.evidence.authority_evidence.toString());
  assert.ok(isStaticMaterial(material), "the authority returned static material evidence");
  const input: StaticSendAttempt = {
    sender: f.egress.sourceControl.sender,
    instanceId: f.installation.enforcement.instanceId,
    useId,
    attemptId: useId,
    material,
    deadlineAt: new Date(
      Number(captured.deadline.seconds) * 1000 + captured.deadline.nanos / 1e6,
    ).toISOString(),
  };
  return { captured, ready, permit: f.permitRequest(captured, ready), input };
}

export function readReceipt(f: DeployedFixture, input: SendAttempt) {
  return f.controller.transact((unit) => unit.egressSendReceipts.find(input));
}

// Faults wrap the real state transaction owner: operations and rollback still run in the
// actual memory adapter. Lost acknowledgments here are scheduling proof, not real PG proof.
export function createReceiptPersistenceFaults() {
  let armed: ArmedFault | undefined;

  function wrapState(state: PlatformStateStore): PlatformStateStore {
    return {
      read: (work) => state.read(work),
      async transact(work) {
        const effect: { current?: ArmedFault } = {};
        async function intercept<Result>(method: FaultMethod, run: () => Promise<Result>) {
          if (armed?.method === method) {
            effect.current = armed;
            armed = undefined;
            if (effect.current.kind === "reject") {
              throw new Error("receipt persistence unavailable");
            }
          }
          return run();
        }
        const result = await state.transact((unit) =>
          work({
            ...unit,
            egressSendReceipts: {
              ...unit.egressSendReceipts,
              insert: (...args) =>
                intercept("insert", () => unit.egressSendReceipts.insert(...args)),
              authorize: (...args) =>
                intercept("authorize", () => unit.egressSendReceipts.authorize(...args)),
              save: (...args) => intercept("save", () => unit.egressSendReceipts.save(...args)),
            },
            credentialSources: {
              ...unit.credentialSources,
              findCredentialWithdrawal: (...args) =>
                intercept("findCredentialWithdrawal", () =>
                  unit.credentialSources.findCredentialWithdrawal(...args),
                ),
              isEgressMaterialRejected: (...args) =>
                intercept("isEgressMaterialRejected", () =>
                  unit.credentialSources.isEgressMaterialRejected(...args),
                ),
            },
          }),
        );
        if (effect.current) {
          effect.current.reached.resolve();
          await effect.current.release.promise;
          if (effect.current.kind === "lost_ack") {
            throw new Error("receipt commit acknowledgment unavailable");
          }
        }
        return result;
      },
    };
  }

  return {
    arm(method: FaultMethod, kind: FaultKind = "pause") {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      armed = { method, kind, reached, release };
      return { reached: reached.promise, release: () => release.resolve() };
    },
    appFactory(t: TestContext, options?: Parameters<typeof createConsoleAppFixture>[1]) {
      return createConsoleAppFixture(t, { ...options, wrapState });
    },
  };
}
