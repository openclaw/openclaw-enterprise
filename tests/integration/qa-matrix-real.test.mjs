import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { selectQaMatrix, validateQaInputs } from "../helpers/qa-selection.mjs";

const selected = process.env.OCC_TEST_QA_MATRIX === "1";

test(
  "shipped installations: canonical QA matrix",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_QA_MATRIX=1; see docs/testing/ci.md#qa-matrix for authorized credentials.",
    timeout: 14_400_000,
  },
  async (context) => {
    const selection = selectQaMatrix();
    validateQaInputs(selection);
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
    const executionFilters = process.execArgv.filter((argument) =>
      /^--test-(?:name|skip)-pattern(?:=|$)/.test(argument),
    );
    const concurrency = Number(process.env.OCC_TEST_QA_CONCURRENCY ?? "2");
    assert.ok(
      Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4,
      "OCC_TEST_QA_CONCURRENCY must be an integer from 1 to 4",
    );
    const { stage, save } = createQaReport(join(artifacts, "matrix.json"), {
      scope: executionFilters.length > 0 ? "partial:filtered" : selection.scope,
      selection: selection.cells,
      executionFilters,
      concurrency,
      exclusions: [
        ...(selection.linearRead
          ? []
          : ["OpenShell Linear READ requires the explicit openshell-linear-read scenario"]),
        "Embedded OpenClaw Slack: unsupported",
        "OpenClaw Codex-native approvals: not applicable",
      ],
    });
    await save();
    context.diagnostic(`QA evidence: ${artifacts}`);
    if (selection.sandboxPolicy) {
      const { verifyQaSandboxPolicy } = await import("../helpers/qa-sandbox-policy.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        "shared Driver configuration and real network enforcement",
        () => verifyQaSandboxPolicy(artifacts),
      );
    }
    if (selection.pluginInstall) {
      const { verifyQaSandboxPolicy } = await import("../helpers/qa-sandbox-policy.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        "selected native plugin installation",
        () => verifyQaSandboxPolicy(artifacts, "plugin-install"),
      );
    }
    if (selection.linearRead) {
      const { verifyOpenShellLinearRead } = await import("../helpers/openshell-linear-read.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        "installed Linear plugin executes a real read",
        () => verifyOpenShellLinearRead(context, artifacts),
        "openshell-linear-read",
      );
    }
    for (const installation of selection.installations.filter((value) =>
      selection.cells.some((cell) => cell.installation === value && cell.scenarios.length > 0),
    )) {
      await context.test(
        `${installation} OCC + Kubernetes compute / Sandbox none`,
        { timeout: 7_000_000 },
        async (installationContext) => {
          const f = await stage(
            installationContext,
            installation,
            "shipped startup, default Namespace and presets",
            () =>
              createQaInstallation(installationContext, installation, artifacts, {
                repositoryInputs: selection.repository,
              }),
          );
          const cells = selection.cells.filter(
            (cell) => cell.installation === installation && cell.scenarios.length > 0,
          );
          let browser;
          let repositoryReady;
          if (f && selection.browser) {
            browser = await stage(
              installationContext,
              installation,
              "authenticated console login",
              () =>
                createQaBrowser(f, {
                  themed: cells.some((cell) => cell.scenarios.includes("model-ui")),
                }),
            );
          }
          if (f && selection.repository) {
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
          for (const selectedCell of cells) {
            const { preset, cell } = selectedCell;
            await installationContext.test(
              `Standard ${preset}`,
              { timeout: 3_000_000 },
              async (cellContext) => {
                const ready = await stage(cellContext, cell, "prepare preset runtime", async () => {
                  assert.ok(f, "blocked by installation startup failure");
                  await prepareQaPreset(f, preset);
                  if (selectedCell.scenarios.includes("codex-search-config")) {
                    f.configuration.drivers.compute.configuration.runtime.codexModelBaseUrl =
                      process.env.OCC_TEST_QA_CODEX_MODEL_BASE_URL;
                    delete f.configuration.drivers.compute.configuration.runtime
                      .codexModelSupportsStandaloneWebSearch;
                    await f.saveInstallation(f.configuration);
                  }
                  return true;
                });
                async function runScenario(parent, name, work) {
                  // Keep the preset's overall deadline; a shorter worker deadline
                  // could interrupt cleanup after individually valid stage durations.
                  await parent.test(name, async (scenarioContext) => {
                    const step = (title, action) =>
                      stage(scenarioContext, cell, title, action, name);
                    const suffix = `-${name}`;
                    try {
                      const agent = await step(
                        "preset deployment and supported authentication",
                        async () => {
                          assert.ok(ready, "blocked by preset preparation failure");
                          return createQaAgent(f, preset, browser?.nativeOrigin, suffix, {
                            apiKeyAuth: name === "codex-search-config",
                          });
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
                    "console-secrets",
                    async (agent, step) => {
                      await step(
                        "console Secret lifecycle, Agent references and Namespace deletion blockers",
                        async () => {
                          assert.ok(browser, "blocked by browser setup failure");
                          await browser.verifySecrets(agent);
                          await browser.verifyNamespaceDeletionBlockers(agent);
                        },
                      );
                    },
                  ],
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
                            assert.equal(agent.revision.gatewayManagedMode, true);
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
                              gatewayManagedMode: agent.revision.gatewayManagedMode,
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
                      if (preset === "OpenClaw") {
                        await step(
                          "embedded configured-provider Secret and real model turn",
                          async () => {
                            // Keep the admitted model and Secret, changing only the logical provider.
                            const values = structuredClone(agent.configuration.values);
                            const selected = values.agents.defaults.model;
                            const primary =
                              typeof selected === "string" ? selected : selected.primary;
                            const id = primary.slice(primary.indexOf("/") + 1);
                            const custom = `configured/${id}`;
                            values.models.providers = {
                              configured: {
                                ...values.models.providers.openai,
                                apiKey: {
                                  source: "env",
                                  provider: "default",
                                  id: "OCE_MODEL_API_KEY",
                                },
                              },
                            };
                            values.agents.defaults.model = custom;
                            values.agents.defaults.models = {
                              [custom]: {
                                ...values.agents.defaults.models[primary],
                                agentRuntime: { id: "openclaw" },
                              },
                            };
                            await f.api(
                              "PATCH",
                              `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
                              { values },
                            );
                            await f.deployAndWait(agent);
                            const gateway = await f.gatewayUrl(agent);
                            try {
                              await assertGatewayModelTurn({
                                gatewayUrl: gateway.url,
                                gatewayPassword: gateway.gatewayPassword,
                                nonce: `QA_CUSTOM_${randomUUID()}`,
                                secrets: [
                                  await protectedText(
                                    process.env.OCC_TEST_QA_OPENAI_KEY_FILE,
                                    "model credential",
                                  ),
                                ],
                              });
                            } finally {
                              await gateway.close();
                            }
                            await f.record("embedded-configured-provider", {
                              agentId: agent.id,
                              revisionId: agent.revision.id,
                              model: custom,
                            });
                          },
                        );
                      }
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
                    "git-write",
                    async (agent, step) => {
                      await step(
                        "native repository clone/edit/commit/push to the granted branch and disposal",
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
                      "codex-search-config",
                      async (agent, step) => {
                        const readConfig = async () =>
                          (
                            await f.execRole(agent, "agent", [
                              "node",
                              "-e",
                              "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(process.env.CODEX_HOME,'config.toml'),'utf8'))",
                            ])
                          ).stdout;
                        let baseline;
                        await step(
                          "installed API-key Agent starts without a search declaration",
                          async () => {
                            baseline = await readConfig();
                            assert.equal(
                              baseline.includes("supports_standalone_web_search"),
                              false,
                            );
                            assert.ok(baseline.includes('model_provider = "openai-compatible"'));
                            assert.equal(agent.harnessAuth.method, "api_key");
                          },
                        );
                        for (const enabled of [false, true]) {
                          await step(
                            `search declaration ${enabled} through supported stop and deploy`,
                            async () => {
                              await stopQaAgent(f, agent);
                              f.configuration.drivers.compute.configuration.runtime.codexModelSupportsStandaloneWebSearch =
                                enabled;
                              await f.saveInstallation(f.configuration);
                              await f.deployAndWait(agent);
                              const actual = await readConfig();
                              const expected = enabled
                                ? baseline.replace(
                                    "supports_websockets = false\n",
                                    "supports_websockets = false\nsupports_standalone_web_search = true\n",
                                  )
                                : baseline;
                              assert.equal(
                                actual === expected,
                                true,
                                "only the explicit capability declaration changes",
                              );
                            },
                          );
                        }
                        await step(
                          "enabled declaration survives another supported stop and deploy",
                          async () => {
                            const before = await f.pod(agent, "agent");
                            const config = await readConfig();
                            await stopQaAgent(f, agent);
                            await f.deployAndWait(agent);
                            assert.notEqual(
                              (await f.pod(agent, "agent")).metadata.uid,
                              before.metadata.uid,
                            );
                            assert.equal((await readConfig()) === config, true);
                            await f.record("codex-search-config", {
                              agentId: agent.id,
                              revisionId: agent.revision.id,
                              omitted: false,
                              explicitFalse: false,
                              explicitTrue: true,
                              persistedAfterRedeploy: true,
                              proof:
                                "installed user configuration and native startup, not live search",
                            });
                          },
                        );
                      },
                    ],
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
                      "git-push-denied",
                      async (agent, step) => {
                        await step(
                          "push outside the granted branch rejected and session disposed",
                          async () => {
                            assert.ok(repositoryReady, "blocked by repository setup failure");
                            await verifyQaRepository(f, agent, "git-push-denied");
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
                      scenarios
                        .filter(([name]) => selectedCell.scenarios.includes(name))
                        .map(([name, work]) => runScenario(workers, name, work)),
                    );
                  },
                );
                // Slack changes installation-wide proxy configuration and shares
                // Socket Mode credentials across installations. Join all workers
                // before setup, and disable its consumer before the next cell.
                if (selectedCell.scenarios.includes("slack")) {
                  await runScenario(cellContext, "slack", async (agent, step) => {
                    await step(
                      "single Slack ingress, one threaded reply and native outbound root",
                      () => verifyQaSlack(f, agent),
                    );
                  });
                } else if (preset === "OpenClaw") {
                  cellContext.diagnostic(
                    "Slack and Codex-native approval policy: not applicable to Standard OpenClaw. Linear READ uses its separate OpenShell scenario.",
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
