import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, symlinkSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  loseHelmResponseWithCompletedHook,
  recoverHelm,
} from "../helpers/production-upgrade-completed-hook.ts";
import { registerDispatchRestoreTests } from "../helpers/production-upgrade-dispatch-restore.ts";
import {
  assertHelmIntent,
  assertPrivateReceipt,
  assertStoppedBeforeWriters,
  runWithInjectedFault,
} from "../helpers/production-upgrade-recovery-evidence.ts";
import type {
  RecoveryFixtureFactory,
  RecoveryFixtureOptions,
} from "../helpers/production-upgrade-recovery-fixture.ts";
import { renderedDocuments, yamlFile } from "../helpers/production-upgrade-recovery-render.ts";
import {
  list,
  optionalField,
  requireRecoveryPreflight,
  type RecoveryState,
} from "../helpers/production-upgrade-recovery-state.ts";
import {
  injectedFault,
  oldRuntime,
  runtime,
} from "../helpers/production-upgrade-recovery-tools.ts";
import { dumpYaml, loadYaml } from "../helpers/qa-utils.mjs";

type PluginRegistration = {
  id: string;
  configuration: Record<string, string>;
};

type MalformedPluginRegistration = {
  id: string;
  configuration?: PluginRegistration["configuration"] | [];
  extra?: true;
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapping(value: unknown): Record<string, unknown> {
  assert.ok(isMapping(value), "expected a mapping in the test document");
  return value;
}

function mappingAt(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current = mapping(value);
  for (const key of keys) {
    current = mapping(current[key]);
  }
  return current;
}

function commandStderr(error: unknown): string {
  assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
  return error.stderr;
}

function decodedInstallation(encoded: unknown): string {
  assert.ok(typeof encoded === "string", "expected Installation data in the Secret");
  return Buffer.from(encoded, "base64").toString();
}

function firstMapping(value: unknown): Record<string, unknown> {
  return mapping(list(value, "test document")[0]);
}

function changeFirstInitContainerMount(spec: unknown): void {
  const container = firstMapping(mapping(spec).initContainers);
  firstMapping(container.volumeMounts).mountPath = "/wrong-directory";
}

async function immutableInstallationSwitch(
  fixture: RecoveryFixtureFactory,
  t: TestContext,
  options: RecoveryFixtureOptions = {},
) {
  const f = await fixture(t, {
    preflightPolicy: true,
    recoveryHooks: true,
    ...options,
  });
  const state = await f.state();
  mapping(state.secret).immutable = true;
  mapping(state.secret).type = "Opaque";
  mappingAt(state.secret, "metadata").namespace = "system";
  const installation = mapping(
    JSON.parse(decodedInstallation(mapping(mapping(state.secret).data)["installation.yaml"])),
  );
  mappingAt(installation, "drivers", "compute", "configuration").images = {
    agent: runtime,
    gateway: runtime,
  };
  // The operator stages equivalent configuration with independent formatting.
  // The mounted bytes, rather than a reserialization, must determine the checksum.
  const staged =
    "# Operator-staged configuration\n" +
    JSON.stringify(Object.fromEntries(Object.entries(installation).reverse()), null, 4) +
    "\n\n";
  const successor = structuredClone(mapping(state.secret));
  const successorMetadata = mapping(successor.metadata);
  successorMetadata.name = "occ-installation-successor";
  successorMetadata.uid = "successor-secret-uid";
  mapping(successor.data)["installation.yaml"] = Buffer.from(staged).toString("base64");
  state.installationSuccessor = successor;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  const values = mapping(await yamlFile(join(f.directory, "values.json")));
  mapping(values.installation).secretName = successorMetadata.name;
  const candidate = join(f.directory, "immutable-values.json");
  await writeFile(candidate, JSON.stringify(values), { mode: 0o600 });
  return {
    ...f,
    original: mapping(state.secret),
    successor,
    staged,
    run: (...args: string[]) => f.run("--candidate-values", candidate, ...args),
  };
}

type ImmutableInstallationSwitch = Awaited<ReturnType<typeof immutableInstallationSwitch>>;

async function assertImmutableInstallationRetained(f: ImmutableInstallationSwitch) {
  const state = await f.state();
  assert.equal(state.installationUpdateReviews ?? 0, 0);
  assert.deepEqual(state.secret, f.original);
  assert.deepEqual(state.installationSuccessor, f.successor);
  assert.ok(!(await f.events()).includes("secret-replaced"));
  const values = await yamlFile(join(f.directory, "live-values"));
  assert.equal(mappingAt(values, "installation").secretName, mapping(f.successor.metadata).name);
  assert.equal(
    mappingAt(values, "controlPlane").installationChecksum,
    createHash("sha256").update(f.staged).digest("hex"),
  );
}

export function registerInstallationRecoveryCases({
  fixture,
}: {
  fixture: RecoveryFixtureFactory;
}): void {
  for (const preflightOnly of [true, false]) {
    test(`mutable Installation update denial on fresh ${preflightOnly ? "preflight" : "apply"}`, async (t) => {
      const f = await fixture(t);
      const state = await f.state();
      state.denyInstallationUpdate = true;
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      const installation = join(f.directory, "installation.json");
      const before = await readFile(installation);
      await assert.rejects(f.run(...(preflightOnly ? ["--preflight-only"] : [])), (error) => {
        const stderr = commandStderr(error);
        assert.match(
          stderr,
          /Kubernetes denied update on Installation Secret system\/occ-installation-startup/,
        );
        assert.doesNotMatch(stderr, /private self-review reason/);
        return true;
      });
      assert.deepEqual(await f.events(), []);
      const after = await f.state();
      assert.equal(after.installationUpdateReviews, 1);
      assert.equal(after.api, 1);
      assert.equal(after.worker, 1);
      assert.deepEqual(after.secret, state.secret);
      assert.deepEqual(await readFile(installation), before);
    });
  }

  test("unavailable mutable Installation update review warns and permits the actual update", async (t) => {
    const f = await fixture(t);
    const state = await f.state();
    state.reviewUnavailable = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const result = await f.run();
    assert.match(result.stderr, /Could not verify update access to the Installation Secret/);
    assert.match(result.stderr, /Could not verify patch access to the worker Deployment/);
    assert.doesNotMatch(result.stderr, /private self-review diagnostic/);
    assert.deepEqual(await f.events(), [
      "scale-api",
      "scale-worker",
      "secret-replaced",
      "migration",
    ]);
  });

  for (const preflightOnly of [false, true]) {
    test(`immutable Installation Secret refuses changed data before ${preflightOnly ? "preflight-only succeeds" : "stopping writers"}`, async (t) => {
      const f = await fixture(t);
      const state = await f.state();
      mapping(state.secret).immutable = true;
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(
        f.run(...(preflightOnly ? ["--preflight-only"] : [])),
        /Installation Secret .* is immutable/,
      );
      assert.deepEqual(await f.events(), []);
      const after = await f.state();
      assert.equal(after.api, 1);
      assert.equal(after.worker, 1);
      assert.equal(after.helmSubmissions ?? 0, 0);
    });
  }

  test("immutable Installation Secret permits an upgrade with equivalent YAML", async (t) => {
    const f = await fixture(t, { controllerOnly: true });
    const state = await f.state();
    mapping(state.secret).immutable = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const installation = join(f.directory, "installation.json");
    appendFileSync(installation, "\n");
    await f.run();
    assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
    assert.deepEqual((await f.state()).secret, state.secret);
    assert.equal((await f.state()).installationUpdateReviews ?? 0, 0);
  });

  test("resume refuses a pending Installation write if the Secret became immutable", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "fail-scale-worker");
    const events = await f.events();
    assert.deepEqual(events, ["scale-api"]);
    const state = await f.state();
    mapping(state.secret).immutable = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run("--resume"), /Installation Secret .* is immutable/);
    assert.deepEqual(await f.events(), events);
    const after = await f.state();
    assert.equal(after.helmSubmissions ?? 0, 0);
    assert.equal(after.installationUpdateReviews, 1);
  });

  test("immutable Installation reference uses staged bytes in preflight and Helm without replacing either Secret", async (t) => {
    const f = await immutableInstallationSwitch(fixture, t);
    await f.run("--preflight-only");
    assert.deepEqual(await f.events(), []);
    const prepared = await f.state();
    const requested = list(requireRecoveryPreflight(prepared).requested, "preflight requests");
    const secret = requested.find((object) => mapping(object).kind === "Secret");
    assert.ok(secret);
    const secretName = mappingAt(secret, "metadata").name;
    const encoded = mappingAt(secret, "data")["installation.yaml"];
    assert.ok(typeof secretName === "string" && typeof encoded === "string");
    assert.equal(decodedInstallation(encoded), f.staged);
    const jobs = requested.filter((object) => mapping(object).kind === "Job");
    assert.equal(jobs.length, 3);
    const jobSpecs = jobs.map((job) => mappingAt(job, "spec", "template", "spec"));
    const startupSpecs = jobSpecs.filter(
      (spec) => firstMapping(spec.containers).name !== "migration",
    );
    assert.equal(startupSpecs.length, 2);
    for (const spec of startupSpecs) {
      const volumes = list(spec.volumes, "startup Job volumes");
      const secretNames = volumes.flatMap((volume) => {
        const { secret } = mapping(volume);
        return isMapping(secret) ? [secret.secretName] : [];
      });
      assert.ok(
        secretNames.includes(secretName),
        "both startup checks must mount the temporary Secret containing the successor bytes",
      );
      assert.ok(!secretNames.includes(mapping(f.original.metadata).name));
    }
    assert.equal(await f.readEvidence("candidate-installation.yaml"), f.staged);
    // Preflight-only evidence is deliberately not resumable. A fresh normal
    // attempt proves that Helm receives the same staged bytes and reference.
    const deployment = await immutableInstallationSwitch(fixture, t);
    await deployment.run();
    await assertImmutableInstallationRetained(deployment);
    assert.deepEqual(await deployment.events(), ["scale-api", "scale-worker", "migration"]);
    assert.ok(existsSync(join(deployment.evidence, "completed")));
  });

  test("immutable Installation reference refuses an unavailable or mismatched successor before stopping writers", async (t) => {
    const changes: [string, (state: RecoveryState) => void, RegExp][] = [
      ["missing", (state) => delete state.installationSuccessor, /not found/],
      [
        "wrong Installation",
        (state) => {
          assert.ok(state.installationSuccessor);
          mapping(mappingAt(state.installationSuccessor, "metadata").annotations)[
            "openclaw.dev/installation-id"
          ] = "ins_other";
        },
        /staged immutable Installation Secret/,
      ],
      [
        "wrong configuration",
        (state) => {
          assert.ok(state.installationSuccessor);
          const encoded = mapping(mapping(state.secret).data)["installation.yaml"];
          assert.ok(typeof encoded === "string", "expected Installation data in the live Secret");
          mapping(mapping(state.installationSuccessor).data)["installation.yaml"] = encoded;
        },
        /candidate Installation configuration/,
      ],
      [
        "mutable",
        (state) => {
          assert.ok(state.installationSuccessor);
          mapping(state.installationSuccessor).immutable = false;
        },
        /staged immutable Installation Secret/,
      ],
      [
        "lost unrelated data",
        (state) => {
          assert.ok(state.installationSuccessor);
          delete mapping(mapping(state.installationSuccessor).data).retained;
        },
        /staged immutable Installation Secret/,
      ],
    ];
    for (const [name, change, refusal] of changes) {
      await t.test(name, async (subtest) => {
        const f = await immutableInstallationSwitch(fixture, subtest);
        const state = await f.state();
        change(state);
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
        await assert.rejects(f.run(), refusal);
        assert.deepEqual(await f.events(), []);
        const after = await f.state();
        assert.equal(after.api, 1);
        assert.equal(after.worker, 1);
        assert.equal(after.helmSubmissions ?? 0, 0);
        assert.equal(
          list(optionalField(after.preflight, "created") ?? [], "preflight creations").length,
          0,
        );
        assert.deepEqual(after.secret, f.original);
      });
    }
  });

  test("immutable Installation preflight rechecks both pins after temporary Jobs finish", async (t) => {
    for (const key of ["secret", "installationSuccessor"] as const) {
      await t.test(key, async (subtest) => {
        const f = await immutableInstallationSwitch(fixture, subtest);
        const state = await f.state();
        state.replaceInstallationDuringPreflight = key;
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
        await assert.rejects(f.run("--preflight-only"), (error) => {
          assert.match(commandStderr(error), /Installation Secret identity or data changed/);
          assert.ok(
            error instanceof Error && "stdout" in error && typeof error.stdout === "string",
          );
          assert.doesNotMatch(error.stdout, /Preflight passed/);
          return true;
        });
        await assertStoppedBeforeWriters(f);
        const after = await f.state();
        const beforeSecret = state[key];
        const afterSecret = after[key];
        assert.ok(beforeSecret && afterSecret);
        const uid = mappingAt(beforeSecret, "metadata").uid;
        assert.ok(typeof uid === "string", "expected the captured Secret UID");
        assert.equal(mappingAt(afterSecret, "metadata").uid, uid + "-replacement");
        const preflight = requireRecoveryPreflight(after);
        assert.equal(list(preflight.logRequests, "preflight log requests").length, 3);
        for (const kind of ["jobs", "pods", "secrets", "networkpolicies"] as const) {
          assert.deepEqual(preflight[kind], {}, "temporary preflight resources must be cleaned");
        }
      });
    }
  });

  test("immutable Installation completion verifies mounted consumers and the owned initializer", async (t) => {
    const f = await immutableInstallationSwitch(fixture, t, { agent: true });
    const state = await f.state();
    // The volume declaration remains correct, but the controller cannot read it
    // at its configured path. Helm success alone must not authorize Agent dispatch.
    state.installationDeploymentMountPath = "/not-the-config-directory";
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run(), /Installation consumer mount differs/);
    const accepted = await f.state();
    delete accepted.installationDeploymentMountPath;
    const mutations: [string, (value: RecoveryState) => void][] = [
      [
        "controller Pod mount",
        (value) => {
          value.installationPodMountPath = "/wrong-directory";
        },
      ],
      [
        "initializer Job mount",
        (value) => {
          assert.ok(value.installationInitializer);
          changeFirstInitContainerMount(
            mappingAt(mapping(value.installationInitializer).job, "spec", "template", "spec"),
          );
        },
      ],
      [
        "initializer Pod mount",
        (value) => {
          assert.ok(value.installationInitializer);
          changeFirstInitContainerMount(mapping(mapping(value.installationInitializer).pod).spec);
        },
      ],
      [
        "foreign initializer Pod",
        (value) => {
          assert.ok(value.installationInitializer);
          firstMapping(
            mappingAt(mapping(value.installationInitializer).pod, "metadata").ownerReferences,
          ).uid = "another-job";
        },
      ],
      [
        "unfinished initializer",
        (value) => {
          assert.ok(value.installationInitializer);
          mapping(mapping(value.installationInitializer).job).status = { active: 1 };
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const changed = structuredClone(accepted);
        mutate(changed);
        await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
        await assert.rejects(
          f.run("--resume"),
          /Installation consumer mount differs|initializer (Job|Pod)/,
        );
        const refused = await f.state();
        assert.equal(refused.helmSubmissions, 1);
        assert.equal(refused.dispatches, 0);
        assert.equal(existsSync(join(f.evidence, "completed")), false);
      });
    }
    await writeFile(join(f.directory, "state.json"), JSON.stringify(accepted));
    await f.run("--resume");
    const completed = await f.state();
    assert.equal(completed.helmSubmissions, 1);
    assert.equal(completed.dispatches, 1);
    const receipt = mapping(JSON.parse(await f.readEvidence("installation-initializer.json")));
    assert.ok(accepted.installationInitializer);
    assert.equal(
      receipt.jobUid,
      mappingAt(mapping(accepted.installationInitializer).job, "metadata").uid,
    );
    assert.equal(
      receipt.podUid,
      mappingAt(mapping(accepted.installationInitializer).pod, "metadata").uid,
    );
    await assertImmutableInstallationRetained(f);
  });

  test("immutable Installation refuses non-string YAML mapping keys on either side", async (t) => {
    for (const plainSide of ["intended", "staged"]) {
      await t.test(plainSide, async (subtest) => {
        const f = await immutableInstallationSwitch(fixture, subtest);
        const state = await f.state();
        const original: unknown = loadYaml(
          decodedInstallation(mapping(mapping(state.secret).data)["installation.yaml"]),
        );
        const successor: unknown = loadYaml(f.staged);
        for (const config of [original, successor]) {
          const compute = mappingAt(config, "drivers", "compute", "configuration");
          compute.network ??= {};
          mapping(compute.network).dns = {
            namespace: "kube-system",
            podLabels: { "0x10": "resolver" },
          };
        }
        const originalBytes = JSON.stringify(original).replace(
          '"0x10":',
          plainSide === "intended" ? "0x10: " : '"0x10":',
        );
        const stagedBytes = JSON.stringify(successor).replace(
          '"0x10":',
          plainSide === "staged" ? "0x10: " : '"0x10":',
        );
        // Both inputs are valid YAML, but the startup parser must see different DNS selectors.
        assert.notDeepEqual(
          mappingAt(
            loadYaml(originalBytes),
            "drivers",
            "compute",
            "configuration",
            "network",
            "dns",
          ),
          mappingAt(loadYaml(stagedBytes), "drivers", "compute", "configuration", "network", "dns"),
        );
        assert.ok(state.installationSuccessor);
        mapping(mapping(state.secret).data)["installation.yaml"] =
          Buffer.from(originalBytes).toString("base64");
        mapping(mapping(state.installationSuccessor).data)["installation.yaml"] =
          Buffer.from(stagedBytes).toString("base64");
        await writeFile(join(f.directory, "installation.json"), originalBytes);
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
        await assert.rejects(f.run(), /string mapping keys/);
        const after = await f.state();
        assert.equal(after.api, 1);
        assert.equal(after.worker, 1);
        assert.equal(after.version, 1);
        assert.deepEqual(await f.events(), []);
        assert.equal(after.helmSubmissions ?? 0, 0);
        assert.equal(
          list(optionalField(after.preflight, "created") ?? [], "preflight creations").length,
          0,
        );
        assert.deepEqual(after.secret, state.secret);
        assert.deepEqual(after.installationSuccessor, state.installationSuccessor);
      });
    }
  });

  test("immutable Installation resume rejects same-values Helm manifest or hook substitution", async (t) => {
    for (const field of ["manifest", "hook"]) {
      await t.test(field, async (subtest) => {
        const f = await immutableInstallationSwitch(fixture, subtest, { agent: true });
        await runWithInjectedFault(f, "lost-helm-response");
        const accepted = await f.state();
        const changed = structuredClone(accepted);
        const release = mapping(changed.installationRelease);
        if (field === "manifest") {
          const manifest = release.manifest;
          assert.ok(typeof manifest === "string", "expected the accepted Helm manifest");
          const documents = renderedDocuments(manifest).map(mapping);
          const deployment = documents.find((object) => object.kind === "Deployment");
          firstMapping(mappingAt(deployment, "spec", "template", "spec").containers).image =
            oldRuntime;
          release.manifest = documents.map((object) => JSON.stringify(object)).join("\n---\n");
        } else {
          const entry = firstMapping(release.hooks);
          const manifest = entry.manifest;
          assert.ok(typeof manifest === "string", "expected the accepted Helm hook manifest");
          const hook = mapping(JSON.parse(manifest));
          const container = firstMapping(
            mappingAt(hook, "spec", "template", "spec").initContainers,
          );
          firstMapping(container.volumeMounts).mountPath = "/another-config";
          entry.manifest = JSON.stringify(hook);
        }
        await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
        await assert.rejects(f.run("--resume"), /Helm.*(manifest|hook set).*differ/);
        const refused = await f.state();
        assert.equal(refused.helmSubmissions, 1);
        assert.equal(refused.dispatches, 0);
        assert.equal(existsSync(join(f.evidence, "completed")), false);
        await writeFile(join(f.directory, "state.json"), JSON.stringify(accepted));
        await f.run("--resume");
        assert.equal((await f.state()).helmSubmissions, 1);
        assert.equal((await f.state()).dispatches, 1);
        await assertImmutableInstallationRetained(f);
      });
    }
  });

  test("immutable Installation reference rechecks both captured UIDs before resumed quiescence", async (t) => {
    const f = await immutableInstallationSwitch(fixture, t);
    // Interrupt a prepared attempt before the first write, then change each
    // retained object's identity independently before resuming that attempt.
    await runWithInjectedFault(f, "fail-scale-api");
    const prepared = await f.state();
    for (const key of ["secret", "installationSuccessor"] as const) {
      const changed = structuredClone(prepared);
      const secret = changed[key];
      assert.ok(secret);
      const uid = mappingAt(secret, "metadata").uid;
      assert.ok(typeof uid === "string", "expected the captured Secret UID");
      mappingAt(secret, "metadata").uid = uid + "-replacement";
      await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
      await assert.rejects(f.run("--resume"), /Installation Secret|immutable Installation/);
      assert.deepEqual(await f.events(), []);
      assert.equal((await f.state()).api, 1);
      assert.equal((await f.state()).worker, 1);
      assert.equal((await f.state()).helmSubmissions ?? 0, 0);
    }
    await writeFile(join(f.directory, "state.json"), JSON.stringify(prepared));
    await f.run("--resume");
    await assertImmutableInstallationRetained(f);
  });

  test("immutable Installation reference resumes partial quiescence and accepted submission without duplicate dispatch", async (t) => {
    const f = await immutableInstallationSwitch(fixture, t, { agent: true });
    await runWithInjectedFault(f, "fail-scale-worker");
    assert.deepEqual(await f.events(), ["scale-api"]);
    assert.equal((await f.state()).worker, 1);
    await runWithInjectedFault(f, "lost-helm-response", "--resume");
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.equal((await f.state()).dispatches, 0);
    // A Ready Pod still mounting the predecessor is not adoption of the staged
    // reference, even if Helm accepted the values and its rollout command passed.
    const stale = await f.state();
    const predecessorName = mapping(f.original.metadata).name;
    assert.ok(typeof predecessorName === "string");
    stale.installationPodSecretName = predecessorName;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(stale));
    await assert.rejects(f.run("--resume"), /Installation.*volume differs/);
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.equal((await f.state()).dispatches, 0);
    delete stale.installationPodSecretName;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(stale));
    await f.run("--resume");
    await assertImmutableInstallationRetained(f);
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.equal((await f.state()).dispatches, 1);
    const completed = await f.events();
    await assert.rejects(f.run("--resume"), /completion marker exists/);
    assert.deepEqual(await f.events(), completed);
  });

  test("immutable Installation reference survives same-candidate Helm recovery and acknowledged resume", async (t) => {
    const f = await immutableInstallationSwitch(fixture, t, { recoveryHooks: true });
    await loseHelmResponseWithCompletedHook(f);
    await runWithInjectedFault(f, "fail-rollout-api", ...recoverHelm);
    assert.equal((await f.state()).version, 3);
    assert.equal((await f.state()).rollbackSubmissions, 1);
    await f.run("--resume");
    await assertImmutableInstallationRetained(f);
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.equal((await f.state()).rollbackSubmissions, 1);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    assert.ok(existsSync(join(f.evidence, "completed")));
  });

  test("an image upgrade can select curated Codex while preserving both plugin registrations", async (t) => {
    const pluginDrivers = [
      { id: "occ-plugin", configuration: {} },
      {
        id: "codex-plugin",
        configuration: {
          catalogSource: "hosted",
          codexExecutable: "/usr/bin/codex",
          codexHome: "/var/lib/codex",
        },
      },
    ] satisfies [PluginRegistration, PluginRegistration];
    const candidatePluginDrivers = structuredClone(pluginDrivers);
    candidatePluginDrivers[1].configuration.catalogSource = "openai-curated";
    const f = await fixture(t, { candidates: true, pluginDrivers, candidatePluginDrivers });
    await f.run();
    const state = await f.state();
    const installed: unknown = loadYaml(
      decodedInstallation(mapping(mapping(state.secret).data)["installation.yaml"]),
    );
    assert.deepEqual(mappingAt(installed, "drivers").plugin, candidatePluginDrivers);
  });
  // Existing installations can retain the former single-registration shape. Only
  // an explicit candidate may convert it, without changing the selected Driver.
  test("an image upgrade can explicitly wrap an existing plugin registration", async (t) => {
    for (const selection of ["occ-plugin", "codex-plugin", "curated-codex"]) {
      await t.test(selection, async (subtest) => {
        const id = selection === "curated-codex" ? "codex-plugin" : selection;
        const pluginDrivers = {
          id,
          configuration:
            id === "codex-plugin"
              ? {
                  catalogSource: "hosted",
                  codexExecutable: "/usr/bin/codex",
                  codexHome: "/var/lib/codex",
                }
              : {},
        };
        const candidate = structuredClone(pluginDrivers);
        if (selection === "curated-codex") {
          candidate.configuration.catalogSource = "openai-curated";
        }
        const candidatePluginDrivers = [candidate];
        const f = await fixture(subtest, {
          candidates: true,
          controllerOnly: true,
          pluginDrivers,
          candidatePluginDrivers,
        });
        await f.run();
        const state = await f.state();
        const installed: unknown = loadYaml(
          decodedInstallation(mapping(mapping(state.secret).data)["installation.yaml"]),
        );
        assert.deepEqual(mappingAt(installed, "drivers").plugin, candidatePluginDrivers);
        assert.equal(state.version, 2);
      });
    }
  });

  test("wrapping a plugin registration preserves protected settings", async (t) => {
    for (const change of [
      "executable",
      "home",
      "driver",
      "extra-driver",
      "configuration-shape",
      "registration-shape",
      "duplicate-driver",
      "unrelated-setting",
      "unknown-installed-driver",
      "installed-extra-field",
      "installed-missing-configuration",
      "installed-configuration-shape",
    ]) {
      await t.test(change, async (subtest) => {
        const pluginDrivers: MalformedPluginRegistration = {
          id: "codex-plugin",
          configuration: {
            catalogSource: "hosted",
            codexExecutable: "/usr/bin/codex",
            codexHome: "/var/lib/codex",
          },
        };
        // Invalid installed registrations must not become accepted through wrapping.
        if (change === "unknown-installed-driver") {
          pluginDrivers.id = "unknown-plugin";
        }
        if (change === "installed-extra-field") {
          pluginDrivers.extra = true;
        }
        if (change === "installed-missing-configuration") {
          delete pluginDrivers.configuration;
        }
        if (change === "installed-configuration-shape") {
          pluginDrivers.configuration = [];
        }
        const candidate = structuredClone(pluginDrivers);
        const candidatePluginDrivers: (MalformedPluginRegistration | string)[] = [candidate];
        if (change === "executable") {
          mapping(candidate.configuration).codexExecutable = "/other/codex";
        }
        if (change === "home") {
          mapping(candidate.configuration).codexHome = "/other/home";
        }
        if (change === "driver") {
          candidate.id = "occ-plugin";
        }
        if (change === "extra-driver") {
          candidatePluginDrivers.push({ id: "occ-plugin", configuration: {} });
        }
        if (change === "configuration-shape") {
          candidate.configuration = [];
        }
        if (change === "registration-shape") {
          candidatePluginDrivers[0] = "codex-plugin";
        }
        if (change === "duplicate-driver") {
          candidatePluginDrivers.push(structuredClone(candidate));
        }
        const f = await fixture(subtest, {
          candidates: true,
          controllerOnly: true,
          pluginDrivers,
          candidatePluginDrivers,
        });
        if (change === "unrelated-setting") {
          const path = join(f.directory, "candidate-installation.json");
          const installation = mapping(JSON.parse(await readFile(path, "utf8")));
          installation.name = "Different installation";
          await writeFile(path, JSON.stringify(installation));
        }
        await assert.rejects(f.run(), /candidate Installation changes a protected setting/);
        assert.deepEqual(await f.events(), []);
      });
    }
  });

  registerDispatchRestoreTests(fixture, injectedFault);

  test("resume reads an accepted Secret write before Helm and preserves its other data", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "lost-secret-response");
    const interrupted = await f.state();
    assert.match(
      decodedInstallation(mapping(mapping(interrupted.secret).data)["installation.yaml"]),
      /bbbbbbbbbbbbbbbb/,
    );
    mapping(interrupted.secret).immutable = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(interrupted));
    await f.run("--resume");
    assert.deepEqual(await f.events(), [
      "scale-api",
      "scale-worker",
      "secret-replaced",
      "migration",
    ]);
    const state = await f.state();
    assert.equal(mapping(mappingAt(state.secret, "metadata").annotations).retained, "yes");
    assert.equal(mapping(mapping(state.secret).data).retained, "cHJlc2VydmVk");
    assert.equal(state.api, 1);
    assert.equal(state.worker, 1);
  });

  test("resume recognizes a committed Helm release without rerunning its migration", async (t) => {
    for (const [fault, operation, component] of [
      ["lost-helm-response", "helm-upgrade", "release"],
      ["fail-rollout-api", "rollout-status", "api"],
      ["fail-rollout-worker", "rollout-status", "worker"],
    ] as const) {
      await t.test(fault, async (subtest) => {
        const f = await fixture(subtest);
        await f.failNext(fault);
        await assert.rejects(f.run(), (error) => {
          assert.ok(error instanceof Error && "code" in error);
          assert.equal(error.code, 9);
          assert.match(commandStderr(error), new RegExp(`${operation}.*${component}.*9`));
          return true;
        });
        const receipt = `${operation}\t${component}\t9\n`;
        const path = join(f.evidence, "native-command-failures.tsv");
        await assertPrivateReceipt(path, receipt);
        // The native failure says nothing about acceptance: Helm committed in
        // every case, and a readback must recover without another migration.
        const state = await f.state();
        assert.equal(state.version, 2);
        assert.equal(state.helmStatus, "deployed");
        assert.equal(state.api, 1);
        assert.equal(state.worker, 1);
        await assertHelmIntent(f, 1, 2);
        await f.run("--resume");
        const resumed = await f.state();
        const created = list(requireRecoveryPreflight(state).created, "preflight creations");
        assert.equal(
          optionalField(optionalField(resumed.preflight, "created"), "length"),
          created.length,
          "a committed Helm release must not create new preflight consumers",
        );
        await assertPrivateReceipt(path, receipt);
        assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
      });
    }
  });

  test("resume refuses an intervening same-values Helm revision even with checked history", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "lost-helm-response");
    const state = await f.state();
    assert.equal(state.version, 2);
    // Another operator submits identical values after the accepted request. Its
    // revision must not be credited to this interrupted submission.
    state.version += 1;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const events = await f.events();
    await assert.rejects(
      f.run("--resume", "--migration-history-checked"),
      /outside this submission/,
    );
    assert.deepEqual(await f.events(), events);
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  });

  test("resume refuses missing, empty or malformed Helm submission evidence", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "lost-helm-response");
    const events = await f.events();
    const path = join(f.evidence, "helm-started");
    const original = mapping(JSON.parse(await readFile(path, "utf8")));
    // Evidence loss must not turn a newer deployed release into an attributed success.
    await rm(path);
    await assert.rejects(f.run("--resume", "--migration-history-checked"), /revision changed/);
    for (const intent of [
      "",
      "{",
      JSON.stringify({ ...original, previousRevision: 0, expectedRevision: 1 }),
      JSON.stringify({ ...original, previousRevision: 1.5, expectedRevision: 2.5 }),
      JSON.stringify({ ...original, previousRevision: 1, expectedRevision: 3 }),
      JSON.stringify(original) + "\n{}",
      JSON.stringify({ previousRevision: 1, expectedRevision: 2 }),
    ]) {
      await writeFile(path, intent, { mode: 0o600 });
      await assert.rejects(f.run("--resume", "--migration-history-checked"), /submission intent/);
    }
    assert.deepEqual(await f.events(), events);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  });

  test("resume rejects invalid intent paths before any new submission", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "fail-scale-worker");
    const events = await f.events();
    const path = join(f.evidence, "helm-started");
    // No Helm request exists at revision 1. A directory must not look absent,
    // or mv can publish inside it and continue without an authoritative intent.
    for (const kind of ["directory", "symlink", "public-file"]) {
      if (kind === "directory") {
        await mkdir(path);
      } else if (kind === "symlink") {
        symlinkSync(join(f.evidence, "before-helm-status.json"), path);
      } else {
        await writeFile(path, JSON.stringify({ previousRevision: 1, expectedRevision: 2 }));
        await chmod(path, 0o644);
      }
      await assert.rejects(f.run("--resume"), (error) => {
        assert.match(commandStderr(error), /regular file|group or other permissions/);
        return true;
      });
      assert.equal((await f.state()).helmSubmissions ?? 0, 0);
      assert.deepEqual(await f.events(), events);
      assert.equal(existsSync(join(f.evidence, "completed")), false);
      await rm(path, { recursive: true });
    }
  });

  test("resume refuses deployed candidate drift rather than retrying Helm", async (t) => {
    for (const changed of ["values", "installation"]) {
      await t.test(changed, async (t) => {
        const f = await fixture(t, { candidates: true });
        const before = await f.state();
        await runWithInjectedFault(f, "lost-helm-response");
        const events = await f.events();
        // Returning either object to its accepted baseline still conflicts with
        // the deployed candidate; checked history cannot authorize another Helm.
        if (changed === "values") {
          await cp(join(f.evidence, "before-live-values.yaml"), join(f.directory, "live-values"));
        } else {
          const current = await f.state();
          mapping(current.secret).data = mapping(before.secret).data;
          await writeFile(join(f.directory, "state.json"), JSON.stringify(current));
        }
        await assert.rejects(
          f.run("--resume", "--migration-history-checked"),
          changed === "values"
            ? /does not match the candidate values/
            : /live Installation Secret does not/,
        );
        assert.deepEqual(await f.events(), events);
        assert.equal((await f.state()).helmSubmissions, 1);
        assert.equal(existsSync(join(f.evidence, "completed")), false);
      });
    }
  });

  test("a nonaccepted Helm submission retries the same successor after checked history", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "reject-helm-submission");
    assert.equal((await f.state()).version, 1);
    await assert.rejects(f.run("--resume"), /migration --check/);
    await runWithInjectedFault(f, "lost-helm-response", "--resume", "--migration-history-checked");
    await assertHelmIntent(f, 1, 2);
    await f.run("--resume");
    assert.equal((await f.state()).version, 2);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  });

  test("controller upgrades remove only an explicitly omitted retired cookie override", async (t) => {
    const removals = ["remove empty", "remove aliased empty", "remove nonempty"];
    for (const mode of [
      ...removals,
      "keep nonempty",
      "change domain",
      "add empty",
      "baseline drift",
    ]) {
      await t.test(mode, async (t) => {
        const f = await fixture(t, { controllerOnly: true });
        const baseline = mapping(await yamlFile(join(f.directory, "values.json")));
        const baselineAdmin: { domain: string; sharedCookieDomain?: string } = {
          domain: "agents.example.test",
        };
        baseline.agentNativeAdmin = baselineAdmin;
        if (mode !== "add empty") {
          // Earlier dev-up installs wrote the parent of the Console and Agent hosts.
          baselineAdmin.sharedCookieDomain = mode.endsWith("nonempty") ? "example.test" : "";
        }
        if (mode === "remove aliased empty") {
          baseline.api ??= {};
          mapping(baseline.api).channelDirectoryProxyUrl = "";
        }
        for (const file of ["values.json", "live-values"]) {
          await writeFile(join(f.directory, file), JSON.stringify(baseline));
        }
        if (mode === "remove aliased empty") {
          // A saved YAML alias and Helm's resolved value describe the same baseline.
          const { agentNativeAdmin, ...settings } = baseline;
          const yaml: unknown = dumpYaml({ ...settings, agentNativeAdmin });
          assert.ok(typeof yaml === "string", "expected saved Helm YAML");
          const saved = yaml
            .replace(/channelDirectoryProxyUrl: (?:''|"")/, 'channelDirectoryProxyUrl: &empty ""')
            .replace(/sharedCookieDomain: (?:''|"")/, "sharedCookieDomain: *empty");
          await writeFile(join(f.directory, "values.json"), saved);
        }
        const candidateAdmin = structuredClone(baselineAdmin);
        const candidate = { ...structuredClone(baseline), agentNativeAdmin: candidateAdmin };
        if (mode !== "keep nonempty") {
          delete candidateAdmin.sharedCookieDomain;
        }
        if (mode === "change domain") {
          candidateAdmin.domain = "other.example.test";
        } else if (mode === "add empty") {
          candidateAdmin.sharedCookieDomain = "";
        } else if (mode === "baseline drift") {
          // Removing the obsolete field from the live baseline must not bypass drift detection.
          await writeFile(join(f.directory, "values.json"), JSON.stringify(candidate));
        }
        const path = join(f.directory, "cookie-candidate.json");
        await writeFile(path, JSON.stringify(candidate), { mode: 0o600 });
        if (removals.includes(mode)) {
          // Exercise the normal helper through Helm submission; the retained baseline
          // must remain attributable while the submitted candidate drops the invalid field.
          await f.run("--candidate-values", path);
          const before = await yamlFile(join(f.evidence, "before-live-values.yaml"));
          const after = await yamlFile(join(f.directory, "live-values"));
          assert.deepEqual(before, baseline);
          assert.deepEqual(mapping(after).agentNativeAdmin, candidate.agentNativeAdmin);
          assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
          assert.equal((await f.state()).helmSubmissions, 1);
        } else {
          await assert.rejects(
            // Keeping the override is the saved baseline itself, as without candidate values.
            mode === "keep nonempty" ? f.run() : f.run("--candidate-values", path),
            mode === "baseline drift"
              ? /protected Helm values differ from the live release/
              : mode === "keep nonempty"
                ? /no longer accepts agentNativeAdmin\.sharedCookieDomain.*omits only that key/
                : /candidate values change a protected setting/,
          );
          assert.deepEqual(await f.events(), []);
          const state = await f.state();
          assert.deepEqual([state.api, state.worker], [1, 1]);
          assert.equal(state.helmSubmissions ?? 0, 0);
          assert.equal(state.preflight, undefined);
        }
      });
    }
  });
}
