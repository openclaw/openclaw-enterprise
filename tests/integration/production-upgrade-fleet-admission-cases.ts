import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { InstallationDeploymentInventoryAgent } from "@openclaw-enterprise/contracts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { runWithInjectedFault } from "../helpers/production-upgrade-recovery-evidence.ts";
import type { RecoveryFixtureFactory } from "../helpers/production-upgrade-recovery-fixture.ts";
import {
  controller,
  execute,
  newBroker,
  newController,
  oldRuntime,
  runtime,
} from "../helpers/production-upgrade-recovery-tools.ts";

function requireObject(value: unknown): Record<string, unknown> {
  const object = asRecord(value);
  assert.ok(object, "expected an object in the upgrade fixture");
  return object;
}

function requireArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "expected an array in the upgrade fixture");
  return value;
}

function computeConfiguration(installation: Record<string, unknown>): Record<string, unknown> {
  const drivers = requireObject(installation.drivers);
  return requireObject(requireObject(drivers.compute).configuration);
}

function commandStderr(error: unknown, code?: number): string {
  assert.ok(
    error instanceof Error && "stderr" in error && typeof error.stderr === "string",
    "expected a command failure with stderr",
  );
  if (code !== undefined) {
    assert.ok("code" in error, "expected a command exit code");
    assert.equal(error.code, code);
  }
  return error.stderr;
}

function capabilityProbe(dispatches: number) {
  return {
    dispatches,
    requests: [{ method: "GET", path: "/v1/capabilities", body: "" }],
  };
}

export function registerFleetAdmissionCases({
  fixture,
}: {
  fixture: RecoveryFixtureFactory;
}): void {
  test("resume refuses a pending Helm release or unrelated Secret changes", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "lost-secret-response");
    const events = await f.events();
    assert.equal(events.filter((event) => event === "secret-replaced").length, 1);
    assert.ok(!events.includes("migration"), "Helm must wait for an acknowledged Secret write");
    // The first Secret replacement was accepted. Neither a pending release nor
    // unrelated Secret drift permits a second write or an Agent dispatch.
    const state = await f.state();
    state.helmStatus = "pending-upgrade";
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run("--resume"), /Helm reports pending-upgrade/);
    assert.deepEqual(await f.events(), events);
    state.helmStatus = "deployed";
    requireObject(requireObject(state.secret).data).retained = "Y2hhbmdlZA==";
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(
      f.run("--resume"),
      /Installation Secret identity or unrelated data changed/,
    );
    assert.deepEqual(await f.events(), events);
    assert.equal((await f.state()).dispatches, 0);
  });

  test("resume rejects malformed protected inputs before another mutation", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "lost-secret-response");
    const path = join(f.directory, "values.json");
    const original = await readFile(path, "utf8");
    const events = await f.events();
    assert.equal(events.filter((event) => event === "secret-replaced").length, 1);
    assert.ok(!events.includes("migration"), "Helm must wait for an acknowledged Secret write");
    // Real yq parses these files. An empty document or non-mapping must stop
    // recovery before it tries the candidate alternative or repeats a write.
    for (const content of ["", `${original}\n---\n`, `42\n---\n${original}`]) {
      await writeFile(path, content);
      await assert.rejects(f.run("--resume"), (error) => {
        const stderr = commandStderr(error, 1);
        assert.match(stderr, /Cannot compare upgrade YAML:.*only YAML mappings/);
        assert.doesNotMatch(stderr, /protected Helm values changed|jq:|Error:/);
        return true;
      });
      assert.deepEqual(await f.events(), events);
    }
  });

  test("resume preserves protected edits when comparison evidence is write-only or unwritable", async (t) => {
    // Root bypasses file permissions; this regression needs an unprivileged owner.
    assert.notEqual(
      process.getuid?.(),
      0,
      "comparison-file permissions require an unprivileged user",
    );
    const f = await fixture(t, { controllerOnly: true });
    await runWithInjectedFault(f, "fail-scale-worker");
    const path = join(f.directory, "values.json");
    const values = requireObject(JSON.parse(await readFile(path, "utf8")));
    const changed = JSON.stringify({ ...values, outsideReviewedUpgrade: true });
    await writeFile(path, changed);
    const events = await f.events();
    // Both valid inputs differ. Evidence permissions cannot make them equal or
    // permit recovery to overwrite the operator's protected file.
    for (const mode of [0o600, 0o200, 0o400]) {
      for (const name of ["compare-actual.json", "compare-expected.json"]) {
        const output = join(f.evidence, name);
        await chmod(output, mode);
        if (mode === 0o200) {
          await assert.rejects(readFile(output), { code: "EACCES" });
        }
      }
      await assert.rejects(f.run("--resume"), (error) => {
        const stderr = commandStderr(error, 1);
        assert.match(
          stderr,
          mode === 0o400 ? /Cannot compare upgrade YAML/ : /protected Helm values changed/,
        );
        assert.doesNotMatch(stderr, /jq:|Permission denied/);
        return true;
      });
      assert.equal(await readFile(path, "utf8"), changed);
      assert.deepEqual(await f.events(), events);
    }
  });

  test("preparation rejects non-mapping candidate documents before protected-setting comparisons", async (t) => {
    for (const name of ["candidate-values.json", "candidate-installation.json"]) {
      await t.test(name, async (t) => {
        const f = await fixture(t, { candidates: true, controllerOnly: true });
        const path = join(f.directory, name);
        const content = `${await readFile(path, "utf8")}\n---\n`;
        // Real yq must reject the trailing empty document before a projection
        // misreports it as a protected-setting or Plugin Driver change.
        await writeFile(path, content);
        await assert.rejects(f.run(), (error) => {
          const stderr = commandStderr(error, 1);
          assert.match(stderr, /Cannot compare upgrade YAML:.*only YAML mappings/);
          assert.doesNotMatch(stderr, /protected setting|Plugin Driver|jq:|Error:/);
          return true;
        });
        assert.equal(await readFile(path, "utf8"), content);
        assert.deepEqual(await f.events(), []);
      });
    }
  });

  test("reviewed settings survive an interrupted controller upgrade without losing unrelated Secret data", async (t) => {
    const f = await fixture(t, {
      candidates: true,
      pluginDrivers: [{ id: "occ-plugin", configuration: {} }],
      controllerOnly: true,
      repositoryCredentials: true,
      simulatePair: true,
    });
    // The Secret write succeeds, but its client loses the response before Helm.
    await runWithInjectedFault(f, "lost-secret-response");
    const interrupted = await f.state();
    const installationYaml = requireObject(requireObject(interrupted.secret).data)[
      "installation.yaml"
    ];
    assert.ok(typeof installationYaml === "string", "expected Installation data in the Secret");
    const installationBytes = Buffer.from(installationYaml, "base64");
    const liveInstallation = requireObject(JSON.parse(installationBytes.toString("utf8")));
    const drivers = requireObject(liveInstallation.drivers);
    const compute = requireObject(requireObject(drivers.compute).configuration);
    assert.deepEqual(drivers.plugin, [
      { id: "occ-plugin", configuration: {} },
      { id: "codex-plugin", configuration: { catalogSource: "openai-curated" } },
    ]);
    assert.equal(requireObject(compute.images).gateway, oldRuntime);
    const backend = requireObject(requireArray(liveInstallation.backend)[0]);
    assert.equal(
      requireObject(backend.configuration).registryPath,
      "/etc/openclaw/repository-registry/registry.json",
    );
    const repository = requireObject(liveInstallation.repository);
    assert.equal(
      requireObject(repository.nativeSender).publicCaPath,
      "/etc/openclaw/repository-ca/ca.crt",
    );
    const network = requireObject(compute.network);
    assert.equal(requireObject(network.repositoryCredentials).port, 8443);
    assert.equal(requireObject(requireObject(interrupted.secret).data).retained, "cHJlc2VydmVk");
    await f.run("--resume");
    const finalState = await f.state();
    const liveValues = requireObject(
      JSON.parse((await execute("yq", ["-o=json", ".", join(f.directory, "live-values")])).stdout),
    );
    assert.equal(
      requireObject(liveValues.api).channelDirectoryProxyUrl,
      "http://198.51.100.25:3128",
    );
    assert.equal(requireObject(liveValues.images).controller, newController);
    assert.equal(
      requireObject(liveValues.repositoryCredentials).hostname,
      "git.system.svc.cluster.local",
    );
    // Helm must use the checksum of the Secret bytes read back after the lost response.
    const expectedChecksum = createHash("sha256").update(installationBytes).digest("hex");
    assert.equal(requireObject(liveValues.controlPlane).installationChecksum, expectedChecksum);
    assert.equal(
      requireObject(requireObject(requireObject(finalState.secret).metadata).annotations).retained,
      "yes",
    );
    assert.equal((await f.events()).filter((event) => event === "secret-replaced").length, 1);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    assert.equal(finalState.dispatches, 0);
  });

  test("stale baseline image fields stop before any writes", { concurrency: true }, async (t) => {
    const cases: Promise<void>[] = [];
    for (const file of ["values", "installation"]) {
      cases.push(
        t.test(file, async (subtest) => {
          const f = await fixture(subtest, { controllerOnly: file === "values" });
          const path = join(f.directory, `${file}.json`);
          const baseline = requireObject(JSON.parse(await readFile(path, "utf8")));
          if (file === "values") {
            requireObject(baseline.images).controller =
              `registry.example.invalid/controller@sha256:${"f".repeat(64)}`;
          } else {
            requireObject(computeConfiguration(baseline).images).gateway = runtime;
          }
          await writeFile(path, JSON.stringify(baseline));
          await assert.rejects(f.run(), /protected (Helm values|Installation YAML) differ/);
          assert.deepEqual(await f.events(), []);
        }),
      );
    }
    await Promise.all(cases);
  });

  test("resume refuses altered reviewed candidates before another mutation", async (t) => {
    const f = await fixture(t, { candidates: true });
    await runWithInjectedFault(f, "lost-secret-response");
    const path = join(f.directory, "candidate-values.json");
    const events = await f.events();
    assert.equal(events.filter((event) => event === "secret-replaced").length, 1);
    assert.ok(!events.includes("migration"), "Helm must wait for an acknowledged Secret write");
    const candidate = requireObject(JSON.parse(await readFile(path, "utf8")));
    requireObject(candidate.api).channelDirectoryProxyUrl = "http://198.51.100.26:3128";
    await writeFile(path, JSON.stringify(candidate));
    await assert.rejects(f.run("--resume"), /reviewed candidate values changed after preparation/);
    assert.deepEqual(await f.events(), events);
    assert.equal((await f.state()).dispatches, 0);
  });

  test(
    "resume refuses changed prepared candidate and fleet evidence before another mutation",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const name of [
        "candidate-values.yaml",
        "targets.jsonl",
        "inventory/restart-preflight.json",
        "prepared-helm-attempt.json",
      ]) {
        cases.push(
          t.test(name, async (subtest) => {
            const f = await fixture(subtest);
            await runWithInjectedFault(f, "fail-scale-worker");
            const events = await f.events();
            // An interrupted release must use the frozen candidate and Agent inventory.
            await writeFile(join(f.evidence, name), "{}\n");
            await assert.rejects(f.run("--resume"), /prepared upgrade evidence changed/);
            assert.deepEqual(await f.events(), events);
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test(
    "candidate cannot redirect a mutable Installation Secret or change an image outside the selected flags",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const field of ["secret", "image"]) {
        cases.push(
          t.test(field, async (subtest) => {
            const f = await fixture(subtest, { candidates: true });
            const path = join(
              f.directory,
              field === "secret" ? "candidate-values.json" : "candidate-installation.json",
            );
            const candidate = requireObject(JSON.parse(await readFile(path, "utf8")));
            if (field === "secret") {
              requireObject(candidate.installation).secretName = "other-installation";
            } else {
              requireObject(computeConfiguration(candidate).images).agent = runtime;
            }
            await writeFile(path, JSON.stringify(candidate));
            await assert.rejects(
              f.run(),
              field === "secret"
                ? /switching the Installation reference requires an immutable predecessor/
                : /candidate Installation change/,
            );
            assert.deepEqual(await f.events(), []);
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test(
    "candidate cannot change repository identity, grants, trust, or the Compute peer",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const change of [
        "registry",
        "driver",
        "duration",
        "peer",
        "compute-authentication",
        "remove",
        "add",
      ]) {
        cases.push(
          t.test(change, async (subtest) => {
            const f = await fixture(subtest, {
              candidates: true,
              repositoryCredentials: change !== "add",
            });
            const path = join(f.directory, "candidate-installation.json");
            const candidate = requireObject(JSON.parse(await readFile(path, "utf8")));
            // These inputs select a registry, grant authority, TLS trust, and the
            // credential service's network peer; no upgrade mutation may follow drift.
            if (change === "registry") {
              const backend = requireObject(requireArray(candidate.backend)[0]);
              requireObject(backend.configuration).registryPath = "/etc/other/registry.json";
            } else if (change === "driver") {
              const repository = requireObject(candidate.repository);
              requireObject(repository.nativeSender).publicCaPath = "/etc/other/ca.crt";
            } else if (change === "duration") {
              const repository = requireObject(candidate.repository);
              requireObject(repository.configuration).sessionDurationSeconds = 3600;
            } else if (change === "peer") {
              const network = requireObject(computeConfiguration(candidate).network);
              const credentials = requireObject(network.repositoryCredentials);
              requireObject(credentials.podLabels)["app.kubernetes.io/component"] = "other";
            } else if (change === "compute-authentication") {
              computeConfiguration(candidate).authentication = {
                mode: "kubeconfig",
                kubeconfigPath: "/etc/other/kubeconfig",
                context: "other",
              };
            } else if (change === "remove") {
              delete candidate.repository;
              delete candidate.backend;
            } else {
              candidate.repository = { id: "repository-credentials", configuration: {} };
              candidate.backend = [
                {
                  id: "github-primary",
                  type: "github",
                  configuration: { registryPath: "/etc/other/registry.json" },
                  drivers: { repo: "repository-credentials" },
                },
              ];
            }
            await writeFile(path, JSON.stringify(candidate));
            await assert.rejects(f.run(), /candidate Installation changes/);
            assert.deepEqual(await f.events(), []);
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test(
    "candidate cannot change cluster credentials or other protected trust settings",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const change of [
        "execution-kubeconfig",
        "gateway-routing",
        "chatgpt-secret",
        "service-principal",
        "trusted-proxy",
        "configuration-authentication",
        "plugin-executable",
        "plugin-hosted",
        "plugin-null",
        "plugin-add-occ",
        "unreviewed-values",
      ]) {
        cases.push(
          t.test(change, async (subtest) => {
            const f = await fixture(subtest, { candidates: true, controllerOnly: true });
            const valuesPath = join(f.directory, "candidate-values.json");
            const installationPath = join(f.directory, "candidate-installation.json");
            const values = requireObject(JSON.parse(await readFile(valuesPath, "utf8")));
            const installation = requireObject(
              JSON.parse(await readFile(installationPath, "utf8")),
            );
            const drivers = requireObject(installation.drivers);
            // Each candidate redirects an identity or trust boundary while retaining
            // the supported proxy and catalog changes; preparation must stop first.
            if (change === "execution-kubeconfig") {
              values.executionCluster = {
                enabled: true,
                apiKubeconfigSecretName: "other-api",
                workerKubeconfigSecretName: "other-worker",
                apiCidrs: ["198.51.100.0/24"],
              };
            } else if (change === "gateway-routing") {
              values.gatewayRouting = { enabled: true, apiKeySecretName: "other-routing-key" };
            } else if (change === "chatgpt-secret") {
              values.backend = { chatgpt: { enabled: true, secretName: "other-chatgpt" } };
            } else if (change === "service-principal") {
              computeConfiguration(installation).servicePrincipalCredentials = {
                mode: "projectedServiceAccountToken",
                audience: "other-audience",
                expirationSeconds: 900,
              };
            } else if (change === "trusted-proxy") {
              computeConfiguration(installation).network = {
                gatewayTrustedProxyCidrs: ["198.51.100.0/24"],
              };
            } else if (change === "configuration-authentication") {
              drivers.configuration = {
                id: "config-kubernetes",
                configuration: {
                  authentication: {
                    mode: "kubeconfig",
                    kubeconfigPath: "/etc/other",
                    context: "other",
                  },
                },
              };
            } else if (change === "plugin-executable") {
              const plugin = requireObject(requireArray(drivers.plugin)[0]);
              requireObject(plugin.configuration).codexExecutable = "/etc/other/codex";
            } else if (change === "plugin-hosted") {
              const plugin = requireObject(requireArray(drivers.plugin)[0]);
              requireObject(plugin.configuration).catalogSource = "hosted";
            } else if (change === "plugin-add-occ") {
              requireArray(drivers.plugin).push({ id: "occ-plugin", configuration: {} });
            } else if (change === "plugin-null") {
              drivers.plugin = null;
            } else {
              values.controlPlane = { extraSetting: true };
            }
            await writeFile(valuesPath, JSON.stringify(values));
            await writeFile(installationPath, JSON.stringify(installation));
            await assert.rejects(f.run(), /candidate (values|Installation) change/);
            assert.deepEqual(await f.events(), []);
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test(
    "repository-enabled upgrades require both image selections before mutation",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const controllerOnly of [true, false]) {
        cases.push(
          t.test(controllerOnly ? "controller release" : "runtime release", async (subtest) => {
            const f = await fixture(subtest, { repositoryCredentials: true, controllerOnly });
            // Either release restarts the worker and broker, so neither may reuse an unverified pair.
            await assert.rejects(
              f.run(),
              /require explicit controller and broker image selections/,
            );
            assert.deepEqual(await f.events(), []);
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test("broker image selection requires an enabled broker before mutation", async (t) => {
    const f = await fixture(t, { controllerOnly: true });
    await assert.rejects(
      f.run("--broker-image", newBroker),
      /requires repository credentials to be enabled/,
    );
    assert.deepEqual(await f.events(), []);
  });

  test("an unchecked repository image pair cannot start an upgrade", async (t) => {
    const f = await fixture(t, { repositoryCredentials: true, controllerOnly: true });
    // Selecting digests alone does not establish their admission compatibility.
    await assert.rejects(f.run("--broker-image", newBroker), /failed compatibility qualification/);
    assert.deepEqual(await f.events(), []);
  });

  // Twelve stranded Agents list ten plus "and 2 more"; exactly ten list all of them, with no
  // "and N more" line.
  for (const count of [12, 10]) {
    test(`${count} running Agents without an active revision are named with their remedy before mutation`, async (t) => {
      const agent = (
        id: string,
        fields: Partial<
          Pick<InstallationDeploymentInventoryAgent, "activeRevisionId" | "desiredRuntimeState">
        > = {},
      ): InstallationDeploymentInventoryAgent => ({
        id,
        status: "active",
        desiredRuntimeState: "running",
        executionMode: "dedicated",
        deploymentInProgress: false,
        ...fields,
      });
      const stranded = Array.from({ length: count }, (_, index) => `agt_stranded_${index + 1}`);
      const f = await fixture(t, {
        inventoryNamespaces: [
          {
            id: "ns_alpha",
            status: "ready",
            agents: [
              agent("agt_healthy", { activeRevisionId: "rev_old" }),
              agent("agt_stopped", { desiredRuntimeState: "stopped" }),
              ...stranded.slice(0, 2).map((id) => agent(id)),
            ],
          },
          { id: "ns_beta", status: "ready", agents: stranded.slice(2).map((id) => agent(id)) },
        ],
        // agt_stranded_2 and ns_beta have no readable name, and agt_stranded_3's is not a string;
        // agt_stranded_1's name carries a quote, a newline, DEL, and a C1 control.
        names: {
          ns_alpha: "Team Alpha",
          agt_stranded_1: 'Mail "triage"\nbot\u007f\u009b',
          agt_stranded_3: 42,
        },
      });
      const stderr = await f
        .run()
        .then(() => assert.fail("the upgrade must refuse"), commandStderr);
      const lines = stderr.trimEnd().split("\n");
      assert.deepEqual(lines, [
        "upgrade-production-images: the deployment inventory contains a running Agent without an active revision; resolve its initial deployment first. No cluster changes were made.",
        '  - Agent agt_stranded_1 "Mail \\"triage\\"\\nbot\\u007f?" in Namespace ns_alpha "Team Alpha"',
        '  - Agent agt_stranded_2 (name unavailable) in Namespace ns_alpha "Team Alpha"',
        ...stranded
          .slice(2, 10)
          .map(
            (id) => `  - Agent ${id} (name unavailable) in Namespace ns_beta (name unavailable)`,
          ),
        ...(count > 10
          ? [
              `  - and ${count - 10} more; see ${join(f.evidence, "inventory/deployment-inventory.json")}`,
            ]
          : []),
        "Stop or delete each running Agent without an active revision (occ --namespace NAMESPACE_ID agent stop AGENT_ID), or deploy it until it succeeds (occ --namespace NAMESPACE_ID agent deploy AGENT_ID), then start again with a new evidence directory. See docs/guides/deploy/production-upgrade.md#upgrade-agent-runtimes.",
      ]);
      // Only name reads: one per listed Agent and one per Namespace, nothing beyond the first ten.
      assert.deepEqual(await f.events(), [
        "read ns_alpha",
        "read agt_stranded_1",
        "read agt_stranded_2",
        "read ns_beta",
        ...stranded.slice(2, 10).map((id) => `read ${id}`),
      ]);
      assert.equal((await f.state()).dispatches, 0);
    });
  }

  test("a changed eligible node stops the upgrade before mutation", async (t) => {
    const f = await fixture(t, {
      agent: true,
      repositoryCredentials: true,
      simulatePair: true,
    });
    // Replace the selected node between preparation and the mutation boundary.
    await f.failNext("change-node");
    await assert.rejects(f.run(), /eligible control-plane nodes changed/);
    assert.deepEqual(await f.events(), []);
  });

  test(
    "deployed pair verification stops before Agent dispatch on failure",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const scenario of [
        { flag: "wrong-broker-identity", error: /deployed worker identity does not match/ },
        {
          flag: "fail-capability",
          error: /deployed controller cannot verify repository admission/,
        },
      ]) {
        cases.push(
          t.test(scenario.flag, async (subtest) => {
            const f = await fixture(subtest, {
              agent: true,
              repositoryCredentials: true,
              simulatePair: true,
            });
            // Helm has completed, but an unqualified Pod must not receive Agent work.
            await f.failNext(scenario.flag);
            await assert.rejects(f.run(), scenario.error);
            assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
            assert.equal((await f.state()).dispatches, 0);
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test(
    "controller upgrade verifies worker placement with and without a repository broker",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const scenario of [
        { name: "broker disabled", repositoryCredentials: false, workerPlacement: "container" },
        {
          name: "broker enabled with existing chart",
          repositoryCredentials: true,
          workerPlacement: "container",
        },
        {
          name: "broker enabled with restartable worker",
          repositoryCredentials: true,
          workerPlacement: "restartable",
        },
      ] as const) {
        cases.push(
          t.test(scenario.name, async (subtest) => {
            const f = await fixture(subtest, {
              controllerOnly: true,
              repositoryCredentials: scenario.repositoryCredentials,
              simulatePair: scenario.repositoryCredentials,
              workerPlacement: scenario.workerPlacement,
            });
            const result = await f.run();
            assert.match(
              result.stdout,
              /Upgraded controller image; no Agent deployments were requested/,
            );
            assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
            assert.equal((await f.state()).controller, newController);
            assert.deepEqual(
              (await f.state()).capabilityProbes,
              scenario.repositoryCredentials ? [capabilityProbe(0), capabilityProbe(0)] : [],
            );
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test(
    "deployed capability gates Agent dispatch and completion",
    { concurrency: true },
    async (t) => {
      await Promise.all(
        [
          {
            name: "old before dispatch",
            replies: [{ status: 200, body: '{"durableAdmissionVersion":0}' }],
            dispatches: 0,
            failure: /deployed controller cannot verify repository admission capability\./,
          },
          {
            name: "denied at completion",
            // An empty scripted sample uses the normal ready response. The
            // completion refusal still follows the sole accepted dispatch.
            replies: [null, { status: 403, body: "{}" }],
            dispatches: 1,
            failure:
              /deployed controller cannot verify repository admission capability at completion/,
          },
        ].map((scenario) =>
          t.test(scenario.name, async (subtest) => {
            const f = await fixture(subtest, {
              agent: true,
              repositoryCredentials: true,
              simulatePair: true,
              capabilityReplies: scenario.replies,
            });
            await assert.rejects(f.run(), (error) => {
              // The sender translates the Unix client's refusal; a direct-client bypass does not.
              const stderr = commandStderr(error);
              assert.match(
                stderr,
                /DependencyUnavailableError: Repository credential control is unavailable\./,
              );
              assert.match(stderr, scenario.failure);
              return true;
            });
            const state = await f.state();
            assert.equal(state.dispatches, scenario.dispatches);
            // The second read follows the sole dispatch; a refusal cannot report completion.
            assert.deepEqual(
              state.capabilityProbes,
              scenario.dispatches === 0
                ? [capabilityProbe(0)]
                : [capabilityProbe(0), capabilityProbe(1)],
            );
          }),
        ),
      );
    },
  );

  test(
    "controller upgrade rejects missing, ambiguous, or invalid worker placement",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const scenario of [
        { name: "missing worker", repositoryCredentials: true, workerPlacement: "missing" },
        { name: "duplicate worker", repositoryCredentials: true, workerPlacement: "ambiguous" },
        {
          name: "nonrestartable worker",
          repositoryCredentials: true,
          workerPlacement: "nonrestartable",
        },
        {
          name: "init worker without broker",
          repositoryCredentials: false,
          workerPlacement: "restartable",
        },
        {
          name: "wrong worker image",
          repositoryCredentials: true,
          workerPlacement: "restartable",
          wrongImage: true,
        },
      ] as const) {
        cases.push(
          t.test(scenario.name, async (subtest) => {
            const f = await fixture(subtest, {
              controllerOnly: true,
              repositoryCredentials: scenario.repositoryCredentials,
              simulatePair: scenario.repositoryCredentials,
              workerPlacement: scenario.workerPlacement,
            });
            if ("wrongImage" in scenario) {
              const state = await f.state();
              state.workerObservedImage = oldRuntime;
              await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
            }
            // A malformed or unexpected Deployment must not be reported as a
            // successful controller rollout, even if the Helm request completed.
            await assert.rejects(f.run(), /exactly one worker with the selected controller image/);
            assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
          }),
        );
      }
      await Promise.all(cases);
    },
  );

  test("a stale bundled Collector config Secret stops the upgrade before mutation", async (t) => {
    const f = await fixture(t, { controllerOnly: true, collector: "stale" });
    await assert.rejects(
      f.run(),
      /Collector config Secret occ-demo-collector-config differs from this checkout's deploy\/logging \(collector\.yaml,kubernetes\.yaml\); refresh it/,
    );
    assert.deepEqual(await f.events(), []);
    assert.equal((await f.state()).controller, controller);
  });

  test("a missing bundled Collector config Secret stops the upgrade before mutation", async (t) => {
    const f = await fixture(t, { controllerOnly: true, collector: "missing" });
    await assert.rejects(
      f.run(),
      /cannot read the Collector config Secret occ-demo-collector-config/,
    );
    assert.deepEqual(await f.events(), []);
  });

  test(
    "a current or explicitly reviewed Collector config Secret lets the upgrade proceed",
    { concurrency: true },
    async (t) => {
      const cases: Promise<void>[] = [];
      for (const [collector, extra] of [
        ["current", []],
        ["stale", ["--collector-config-reviewed"]],
      ] as const) {
        cases.push(
          t.test(`${collector} ${extra.join(" ")}`.trim(), async (subtest) => {
            const f = await fixture(subtest, { controllerOnly: true, collector });
            await f.run(...extra);
            assert.equal((await f.state()).controller, newController);
            const drift = (await f.readEvidence("collector-config-drift")).trim();
            assert.equal(drift, collector === "stale" ? "collector.yaml\nkubernetes.yaml" : "");
          }),
        );
      }
      await Promise.all(cases);
    },
  );
}
