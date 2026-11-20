import assert from "node:assert/strict";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import type { TestContext } from "node:test";

import {
  emitOpenShellProgress,
  emitOpenShellReplacementCheckpoint,
  openShellProgressPrefix,
} from "../../scripts/ci/openshell-progress.mjs";
import { redeployOpenShellReplacement } from "../helpers/openshell-replacement-activation.ts";
import { runOpenShellStage } from "../helpers/openshell-stage.ts";

type ReplacementMode =
  | "setup"
  | "request"
  | "same-revision"
  | "activation"
  | "reconciliation"
  | "out-of-order"
  | "extra-field"
  | "later-stage"
  | "wrong-case"
  | "wrong-lane"
  | "wrong-file"
  | "wrong-manifest"
  | "wrong-declaration"
  | "completed-wrapper-emitter"
  | "case-deadline"
  | "runner-deadline"
  | "runner-deadline-after-activation"
  | "runner-deadline-after-wrapper"
  | "success";

export interface OpenShellReplacementChildOptions {
  mode: ReplacementMode;
  requestOrderPath: string;
  requestStart: string;
  requestBeforeFailure: string;
  requestAttempted: string;
  sameRevisionRefusal: string;
  activationPoll: string;
  pendingMessage: string;
}

type Waiter =
  typeof import("../helpers/openshell-sandbox-workflows.mjs").waitForReplacementActivation;

function waitForReceipt(path: string, expected: string, signal: AbortSignal): Promise<void> {
  const observed = () => (existsSync(path) ? readFileSync(path, "utf8") : "");
  return new Promise((resolve, reject) => {
    const watcher = watch("state", { signal }, check);
    watcher.once("error", reject);
    watcher.once("close", () => {
      if (observed() === expected) {
        resolve();
      } else {
        reject(new Error("request reporter did not acknowledge the case"));
      }
    });
    function check() {
      const order = observed();
      if (order === expected || !expected.startsWith(order)) {
        watcher.close();
      }
    }
    check();
  });
}

async function loadWaiter(): Promise<Waiter> {
  return (await import("../helpers/openshell-sandbox-workflows.mjs")).waitForReplacementActivation;
}

function reachesActivation(mode: ReplacementMode) {
  return ![
    "setup",
    "request",
    "same-revision",
    "out-of-order",
    "extra-field",
    "completed-wrapper-emitter",
    "runner-deadline",
  ].includes(mode);
}

export async function prepareOpenShellReplacementChild(options: OpenShellReplacementChildOptions) {
  // Preserve the original case deadline: expensive activation dependencies load before registration.
  const waiter = reachesActivation(options.mode) ? await loadWaiter() : undefined;
  return (context: TestContext, failure: Error) => runScenario(context, options, failure, waiter);
}

async function runScenario(
  t: TestContext,
  options: OpenShellReplacementChildOptions,
  failure: Error,
  waiter: Waiter | undefined,
) {
  const { mode } = options;
  if (mode === "completed-wrapper-emitter") {
    // Supply the genuine failed measurement and terminal, but none of the earlier progress.
    emitOpenShellProgress("replacement", "failed");
    t.diagnostic(
      'openclaw-ci-measurement {"kind":"openshell-stage","stage":"replacement","outcome":"failed","elapsedMs":1}',
    );
    throw failure;
  }
  const sameRevision = mode === "same-revision";
  const observedRequest =
    mode === "request" || sameRevision || mode === "activation" || mode === "reconciliation";
  const controlledDeadline =
    mode === "runner-deadline-after-activation" || mode === "runner-deadline-after-wrapper";
  const pendingActivation = mode === "case-deadline" || controlledDeadline;
  if (observedRequest) {
    await waitForReceipt(options.requestOrderPath, options.requestStart, t.signal);
  }
  for (const step of ["installation", "exposure-auth", "initial-model"]) {
    await runOpenShellStage(t, step, async () => {});
  }
  let sameRevisionError: assert.AssertionError | undefined;
  const replacement = runOpenShellStage(
    t,
    "replacement",
    async () => {
      if (mode === "setup") {
        throw failure;
      }
      if (mode === "out-of-order") {
        emitOpenShellReplacementCheckpoint("activation");
        emitOpenShellReplacementCheckpoint("redeploy-request");
        throw failure;
      }
      if (mode === "extra-field") {
        process.stdout.write(
          openShellProgressPrefix +
            JSON.stringify({
              kind: "openshell-replacement-checkpoint",
              checkpoint: "redeploy-request",
              extra: "private-progress-extra",
            }) +
            "\n",
        );
        throw failure;
      }
      // The equal-revision assertion must quote the fixture credential for the redaction check.
      const previousRevisionId = sameRevision
        ? process.env.CI_RUNNER_FIXTURE_CREDENTIAL
        : "private-previous-id";
      assert.ok(previousRevisionId);
      const response = { status: 202, data: { id: "private-replacement-id" } };
      const agentPath = "/namespaces/fixture/agents/fixture";
      async function request(method: "POST", path: string): Promise<typeof response>;
      async function request(
        method: "GET",
        path: string,
      ): Promise<{ status: number; data: { activeRevisionId: string } }>;
      async function request(method: "POST" | "GET", path: string) {
        if (method === "POST") {
          assert.equal(path, agentPath + "/deploy");
          if (observedRequest) {
            writeFileSync(options.requestAttempted, "invoked", { flag: "wx" });
          }
          if (mode === "request") {
            throw failure;
          }
          if (sameRevision) {
            return { status: 202, data: { id: previousRevisionId } };
          }
          return response;
        }
        assert.equal(method, "GET");
        if (sameRevision) {
          writeFileSync(options.activationPoll, "polling");
        }
        if (path === agentPath) {
          if (pendingActivation) {
            writeFileSync(options.activationPoll, "polling");
            if (controlledDeadline) {
              t.log(options.pendingMessage);
            }
            // Keep Node alive while the real activation poll and its caller are pending.
            const hold = setInterval(() => {
              // Wake a pending stdout read without emitting progress.
              if (controlledDeadline) {
                process.stdout.write("\n");
              }
            }, 1000);
            t.signal.addEventListener("abort", () => clearInterval(hold), { once: true });
            return new Promise<never>(() => {});
          }
          return {
            status: 200,
            data: {
              activeRevisionId: mode === "activation" ? topology.revision.id : response.data.id,
            },
          };
        }
        assert.equal(path, agentPath + "/deployments/" + response.data.id);
        assert.equal(mode, "activation");
        throw failure;
      }
      const topology = {
        namespaceId: "fixture",
        agent: { id: "fixture" },
        revision: { id: previousRevisionId },
        request,
        async diagnoseRevision() {
          return {};
        },
      };
      try {
        const deployed = await redeployOpenShellReplacement(topology, true, async (redeployed) => {
          const activate = waiter ?? (await loadWaiter());
          await activate(topology, redeployed, t, undefined, async () => "");
        });
        assert.equal(deployed, response);
      } catch (error: unknown) {
        if (mode === "activation" || mode === "request") {
          assert.equal(error, failure);
        }
        if (
          sameRevision &&
          error instanceof assert.AssertionError &&
          error.operator === "notStrictEqual" &&
          error.actual === previousRevisionId &&
          error.expected === previousRevisionId
        ) {
          sameRevisionError = error;
        }
        throw error;
      }
      if (mode === "reconciliation" || mode.startsWith("wrong-")) {
        throw failure;
      }
    },
    "pod-replacement",
  );
  if (observedRequest) {
    try {
      await replacement;
    } catch (error: unknown) {
      const expectedFailure = sameRevision ? sameRevisionError : failure;
      if (expectedFailure !== undefined && error === expectedFailure) {
        // Wait for the last progress row while the native case is still active.
        await waitForReceipt(options.requestOrderPath, options.requestBeforeFailure, t.signal);
        if (sameRevision) {
          writeFileSync(options.sameRevisionRefusal, "refused", { flag: "wx" });
        }
      }
      throw error;
    }
  } else {
    await replacement;
  }
  if (mode === "later-stage") {
    await runOpenShellStage(t, "untrusted-upstream", async () => {
      throw failure;
    });
  }
}
