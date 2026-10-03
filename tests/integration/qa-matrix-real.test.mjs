import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
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
    const { createQaInstallation, prepareQaPreset, createQaAgent } =
      await import("../helpers/qa-installation.mjs");
    const { protectedText } = await import("../helpers/qa-secrets.mjs");
    const { createQaReport } = await import("../helpers/qa-report.mjs");
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
    const concurrency = Number(process.env.OCC_TEST_QA_CONCURRENCY ?? "2");
    assert.ok(
      Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4,
      "OCC_TEST_QA_CONCURRENCY must be an integer from 1 to 4",
    );
    const { stage, save } = createQaReport(join(artifacts, "matrix.json"), {
      scope:
        executionFilters.length > 0
          ? `partial:filtered:${selection}`
          : selection === "all"
            ? "full"
            : `partial:${selection}`,
      executionFilters,
      concurrency,
      exclusions: [
        "Linear READ: explicitly excluded; provider currently broken",
        "Embedded OpenClaw Slack: unsupported",
        "OpenClaw Codex-native approvals: not applicable",
      ],
    });
    await save();
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
                const ready = await stage(cellContext, cell, "prepare preset runtime", async () => {
                  assert.ok(f, "blocked by installation startup failure");
                  await prepareQaPreset(f, preset);
                  return true;
                });
                async function runScenario(parent, name, work) {
                  await parent.test(name, { timeout: 1_800_000 }, async (scenarioContext) => {
                    const step = (title, action) =>
                      stage(scenarioContext, cell, title, action, name);
                    const suffix = `-${name}`;
                    try {
                      const agent = await step(
                        "preset deployment and supported authentication",
                        async () => {
                          assert.ok(ready, "blocked by preset preparation failure");
                          return createQaAgent(f, preset, browser?.nativeOrigin, suffix);
                        },
                      );
                      await work(agent, (title, action) =>
                        step(title, async () => {
                          assert.ok(agent, "blocked by Agent deployment failure");
                          return action();
                        }),
                      );
                    } finally {
                      // Include partially provisioned Agents whose deployment threw.
                      // Cleanup belongs to this worker, never another worker's Agent.
                      const owned = f?.agents.find(
                        (agent) => agent.preset === preset && agent.qaScenario === suffix,
                      );
                      if (owned && !owned.stopped) {
                        await step("ordinary Agent cleanup", async () => {
                          try {
                            await stopQaAgent(f, owned);
                          } catch (error) {
                            f.retained = true;
                            throw error;
                          }
                        });
                      }
                    }
                  });
                }
                const scenarios = [
                  [
                    "model-ui",
                    async (agent, step) => {
                      await step(
                        "real model nonce, unauthenticated denial and exact identity",
                        async () => {
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
                              (
                                await f.api(
                                  "GET",
                                  `/namespaces/${agent.namespaceId}/agents/${agent.id}`,
                                )
                              ).activeRevisionId,
                              agent.revision.id,
                            );
                            const nativePod =
                              preset === "Codex" ? await f.pod(agent, "agent") : gateway.pod;
                            await f.record(`${preset}-model`, {
                              agentId: agent.id,
                              revisionId: agent.revision.id,
                              podUid: gateway.pod.metadata.uid,
                              nativePodUid: nativePod.metadata.uid,
                              images: gateway.pod.status.containerStatuses.map(
                                ({ name, imageID }) => ({
                                  name,
                                  imageID,
                                }),
                              ),
                              nonce,
                              unauthenticatedRejected: true,
                            });
                          } finally {
                            await gateway.close();
                          }
                        },
                      );
                      await step(
                        "trusted native UI and live WebSocket model response",
                        async () => {
                          assert.ok(browser, "blocked by browser setup failure");
                          await browser.verify(agent);
                        },
                      );
                    },
                  ],
                  [
                    "git-full",
                    async (agent, step) => {
                      await step(
                        "native repository clone/edit/commit/push/PR and disposal",
                        async () => {
                          assert.ok(repositoryReady, "blocked by repository setup failure");
                          await verifyQaRepository(f, agent);
                        },
                      );
                    },
                  ],
                ];
                if (preset === "Codex") {
                  scenarios.push(
                    [
                      "calendar",
                      async (agent, step) => {
                        await step(
                          "Calendar read, allow-once, subsequent denial and disabled tool",
                          async () => {
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
                      },
                    ],
                    [
                      "git-read",
                      async (agent, step) => {
                        await step(
                          "read-only repository push rejected and session disposed",
                          async () => {
                            assert.ok(repositoryReady, "blocked by repository setup failure");
                            await verifyQaRepository(f, agent, "git-read");
                          },
                        );
                      },
                    ],
                  );
                }
                await cellContext.test(
                  "independent agent scenarios",
                  { concurrency },
                  async (workers) => {
                    await Promise.all(
                      scenarios.map(([name, work]) => runScenario(workers, name, work)),
                    );
                  },
                );
                // Slack changes installation-wide proxy configuration and shares
                // Socket Mode credentials across installations. Join all workers
                // before setup, and disable its consumer before the next cell.
                if (preset === "Codex") {
                  await runScenario(cellContext, "slack", async (agent, step) => {
                    await step(
                      "single Slack ingress, one threaded reply and native outbound root",
                      () => verifyQaSlack(f, agent),
                    );
                  });
                } else {
                  cellContext.diagnostic(
                    "Slack and Codex-native approval policy: not applicable to Standard OpenClaw. Linear READ excluded throughout.",
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
