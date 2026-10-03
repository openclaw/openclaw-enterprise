import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const selected = process.env.OCC_TEST_QA_MATRIX === "1";

test(
  "shipped installations: canonical QA matrix",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_QA_MATRIX=1; see docs/testing/qa-matrix.md for authorized credentials.",
    timeout: 14_400_000,
  },
  async (context) => {
    const { createQaInstallation, createQaAgent } = await import("../helpers/qa-installation.mjs");
    const { protectedText, redactQaError } = await import("../helpers/qa-secrets.mjs");
    const { createQaBrowser } = await import("../helpers/qa-browser.mjs");
    const { prepareQaRepository, verifyQaRepository, stopQaAgent } =
      await import("../helpers/qa-repository.mjs");
    const { verifyCalendarReviewPolicy } = await import("../helpers/calendar-review.mjs");
    const { verifyQaSlack } = await import("../helpers/qa-slack.mjs");
    const { assertGatewayModelTurn } = await import("../helpers/kubernetes-real.mjs");
    const artifacts = process.env.OCC_TEST_QA_ARTIFACTS
      ? resolve(process.env.OCC_TEST_QA_ARTIFACTS)
      : await mkdtemp(join(tmpdir(), "oce-qa-matrix-evidence-"));
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const selection = process.env.OCC_TEST_QA_INSTALLATION ?? "all";
    assert.ok(
      ["all", "compose", "kubernetes"].includes(selection),
      "invalid QA installation selection",
    );
    const installations = selection === "all" ? ["compose", "kubernetes"] : [selection];
    const executionFilters = process.execArgv.filter((argument) =>
      /^--test-(?:name|skip)-pattern(?:=|$)/.test(argument),
    );
    const outcomes = [];
    const save = () =>
      writeFile(
        join(artifacts, "matrix.json"),
        JSON.stringify(
          {
            scope:
              executionFilters.length > 0
                ? `partial:filtered:${selection}`
                : selection === "all"
                  ? "full"
                  : `partial:${selection}`,
            executionFilters,
            outcomes,
            exclusions: [
              "Linear READ: explicitly excluded; provider currently broken",
              "Embedded OpenClaw Slack: unsupported",
              "OpenClaw Codex-native approvals: not applicable",
            ],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    async function stage(parent, cell, name, work) {
      let value;
      await parent.test(name, { timeout: 1_800_000 }, async () => {
        try {
          value = await work();
          outcomes.push({ cell, stage: name, outcome: "passed" });
        } catch (error) {
          redactQaError(error);
          outcomes.push({
            cell,
            stage: name,
            outcome: /blocked by/.test(error.message) ? "blocked" : "failed",
            reason: error.message,
          });
          throw error;
        } finally {
          await save();
        }
      });
      return value;
    }
    context.diagnostic(`QA evidence: ${artifacts}`);
    for (const installation of installations) {
      await context.test(
        `${installation} OCC + Kubernetes compute / Sandbox none`,
        { timeout: 7_000_000 },
        async (installationContext) => {
          const f = await stage(
            installationContext,
            installation,
            "shipped startup, default Namespace and presets",
            () => createQaInstallation(installationContext, installation, artifacts),
          );
          let browser;
          let repositoryReady;
          if (f) {
            browser = await stage(
              installationContext,
              installation,
              "authenticated console login",
              () => createQaBrowser(f),
            );
            repositoryReady = await stage(
              installationContext,
              installation,
              "repository broker setup",
              async () => {
                await prepareQaRepository(f);
                return true;
              },
            );
          }
          for (const preset of ["OpenClaw", "Codex"]) {
            const cell = `${installation}/${preset}`;
            await installationContext.test(
              `Standard ${preset}`,
              { timeout: 3_000_000 },
              async (cellContext) => {
                const agent = await stage(
                  cellContext,
                  cell,
                  "preset deployment and supported authentication",
                  async () => {
                    assert.ok(f, "blocked by installation startup failure");
                    return createQaAgent(f, preset, browser?.nativeOrigin);
                  },
                );
                const required = () => assert.ok(agent, "blocked by Agent deployment failure");
                await stage(
                  cellContext,
                  cell,
                  "real model nonce, unauthenticated denial and exact identity",
                  async () => {
                    required();
                    const gateway = await f.gatewayUrl(agent);
                    try {
                      const nonce = `QA_MODEL_${randomUUID()}`;
                      await assertGatewayModelTurn({
                        gatewayUrl: gateway.url,
                        gatewayPassword: gateway.gatewayPassword,
                        nonce,
                        secrets: [
                          await protectedText(
                            process.env[
                              preset === "Codex"
                                ? "OCC_TEST_QA_CODEX_TOKEN_FILE"
                                : "OCC_TEST_QA_OPENAI_KEY_FILE"
                            ],
                            "model credential",
                          ),
                        ],
                      });
                      assert.equal(
                        (await f.pod(agent, "gateway")).metadata.uid,
                        gateway.pod.metadata.uid,
                      );
                      assert.equal(
                        (await f.api("GET", `/namespaces/${agent.namespaceId}/agents/${agent.id}`))
                          .activeRevisionId,
                        agent.revision.id,
                      );
                      const nativePod =
                        preset === "Codex" ? await f.pod(agent, "agent") : gateway.pod;
                      await f.record(`${preset}-model`, {
                        agentId: agent.id,
                        revisionId: agent.revision.id,
                        podUid: gateway.pod.metadata.uid,
                        nativePodUid: nativePod.metadata.uid,
                        images: gateway.pod.status.containerStatuses.map(({ name, imageID }) => ({
                          name,
                          imageID,
                        })),
                        nonce,
                        unauthenticatedRejected: true,
                      });
                    } finally {
                      await gateway.close();
                    }
                  },
                );
                await stage(
                  cellContext,
                  cell,
                  "trusted native UI and live WebSocket model response",
                  async () => {
                    required();
                    assert.ok(browser, "blocked by browser setup failure");
                    await browser.verify(agent);
                  },
                );
                if (preset === "Codex") {
                  await stage(
                    cellContext,
                    cell,
                    "Calendar read, allow-once, subsequent denial and disabled tool",
                    async () => {
                      required();
                      const credential = {
                        accessToken: await protectedText(
                          process.env.OCC_TEST_QA_CODEX_TOKEN_FILE,
                          "Codex service-account credential",
                        ),
                      };
                      await verifyCalendarReviewPolicy(
                        { ...f, ...agent.native },
                        agent,
                        credential,
                      );
                    },
                  );
                  await stage(
                    cellContext,
                    cell,
                    "single Slack ingress, one threaded reply and native outbound root",
                    async () => {
                      required();
                      await verifyQaSlack(f, agent);
                    },
                  );
                } else {
                  cellContext.diagnostic(
                    "Slack and Codex-native approval policy: not applicable to Standard OpenClaw. Linear READ excluded throughout.",
                  );
                }
                await stage(
                  cellContext,
                  cell,
                  "native repository clone/edit/commit/push/PR and disposal",
                  async () => {
                    required();
                    assert.ok(repositoryReady, "blocked by repository setup failure");
                    await verifyQaRepository(f, agent);
                  },
                );
                if (preset === "Codex") {
                  await stage(
                    cellContext,
                    cell,
                    "read-only repository push rejected and session disposed",
                    async () => {
                      required();
                      assert.ok(repositoryReady, "blocked by repository setup failure");
                      assert.ok(
                        f.repositoryObserverReady,
                        "blocked by independent repository observer failure",
                      );
                      if (!agent.stopped) {
                        await stopQaAgent(f, agent);
                      }
                      const readOnlyAgent = await createQaAgent(
                        f,
                        preset,
                        browser?.nativeOrigin,
                        "-read-only",
                      );
                      await verifyQaRepository(f, readOnlyAgent, "git-read");
                    },
                  );
                }
                for (const pending of f?.agents.filter(
                  (value) => value.preset === preset && !value.stopped,
                ) ?? []) {
                  await stage(cellContext, cell, `ordinary Agent cleanup ${pending.id}`, () =>
                    stopQaAgent(f, pending),
                  );
                }
              },
            );
          }
        },
      );
    }
    await save();
  },
);
