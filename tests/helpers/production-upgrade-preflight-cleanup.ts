import assert from "node:assert/strict";
import { constants, existsSync, statSync } from "node:fs";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

type PreflightIdentity = { kind: string; name: string; uid: string };
type PreflightResource = {
  metadata: {
    name: string;
    uid: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    ownerReferences?: { uid: string }[];
  };
};

type PreflightState = {
  created?: PreflightIdentity[];
  children?: PreflightIdentity[];
  deleted: string[];
  jobs: Record<string, PreflightResource & { foreign?: true }>;
  networkpolicies: Record<string, PreflightResource>;
  pods: Record<string, PreflightResource>;
  secrets: Record<string, PreflightResource & { data: Record<string, string> }>;
};

type PreflightResult = { phase: "Succeeded" | "Failed"; log: string };

type FixtureOptions = {
  controllerOnly: true;
  preflightPolicy: true;
  preflightFault: {
    target:
      "networkpolicy.networking.k8s.io" | "secret" | "api" | "worker" | "migration" | "job.batch";
    mode:
      | "interrupt"
      | "interrupt-hard"
      | "evidence-file"
      | "evidence-symlink"
      | "conflict"
      | "lost"
      | "empty"
      | "newline"
      | "decode"
      | "replacement"
      | "replacement-after-delete"
      | "child-replacement-after-delete"
      | "delete-refused"
      | "foreign-child"
      | "retained-child"
      | "already-absent"
      | "absent-job-retained-child"
      | "delayed-delete"
      | "retained-dependency";
    uid?: string;
  };
  preflightResults?: { api?: PreflightResult; worker: PreflightResult };
};

type UpgradeFixture = {
  directory: string;
  evidence: string;
  commands: string[];
  run(...args: string[]): Promise<unknown>;
  cleanup(...args: string[]): Promise<unknown>;
  state(): Promise<{ preflight: PreflightState }>;
  events(): Promise<string[]>;
};

async function runForFailure(fixture: Pick<UpgradeFixture, "run">, ...args: string[]) {
  try {
    await fixture.run(...args);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok("code" in error && typeof error.code === "number");
    assert.ok("stdout" in error && typeof error.stdout === "string");
    assert.ok("stderr" in error && typeof error.stderr === "string");
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.fail("expected the upgrade command to reject");
}

function assertPreflightIdentityFields(record: object): asserts record is PreflightIdentity {
  assert.ok(
    "kind" in record && typeof record.kind === "string",
    "expected preflight identity kind to be a string",
  );
  assert.ok(
    "name" in record && typeof record.name === "string",
    "expected preflight identity name to be a string",
  );
  assert.ok(
    "uid" in record && typeof record.uid === "string",
    "expected preflight identity uid to be a string",
  );
}

// The command fixture models API inventory and conditional deletion; it is not a live cluster.
// Read only the fixed identity records, never manifests or create stdout.
export async function preflightIdentities(f: { evidence: string }): Promise<PreflightIdentity[]> {
  const records: PreflightIdentity[] = [];
  for (const slot of [
    "networkpolicy",
    "secret",
    "api",
    "worker",
    "migration",
    "api-pod",
    "worker-pod",
    "migration-pod",
  ]) {
    const filename = join(f.evidence, `preflight-${slot}-identity.json`);
    let handle;
    try {
      handle = await open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      assert.ok(stats.isFile());
      assert.equal(stats.mode & 0o777, 0o600);
      const text = await handle.readFile("utf8");
      const record: unknown = JSON.parse(text);
      assert.ok(
        typeof record === "object" && record !== null,
        "expected a preflight identity object",
      );
      assert.deepEqual(Object.keys(record).sort(), ["kind", "name", "uid"]);
      assert.doesNotMatch(
        text,
        /private-response-marker|private-manifest-sentinel|private-secret-sentinel|installation.yaml|apiVersion|spec|data/,
      );
      assertPreflightIdentityFields(record);
      records.push(record);
    } finally {
      await handle.close();
    }
  }
  return records;
}

async function assertCleanupOmitsMarker(evidence: string, marker: string) {
  for (const entry of await readdir(evidence, { withFileTypes: true })) {
    if (!entry.name.startsWith("preflight-cleanup")) {
      continue;
    }
    const path = join(evidence, entry.name);
    const files = entry.isDirectory()
      ? (await readdir(path)).map((name) => join(path, name))
      : [path];
    for (const file of files) {
      assert.ok(!(await readFile(file, "utf8")).includes(marker), `${file} excludes private data`);
    }
  }
}

export function registerPreflightCleanupTests(
  fixture: (t: TestContext, options: FixtureOptions) => Promise<UpgradeFixture>,
): void {
  const settlement = ["--previous-process-settled", "--evidence-unrestored"];

  for (const mode of ["interrupt", "interrupt-hard"] as const) {
    test(`cleanup restart: ${mode} producer is cleaned by a separate invocation`, async (t) => {
      const f = await fixture(t, {
        controllerOnly: true,
        preflightPolicy: true,
        preflightFault: { target: "secret", mode },
      });
      // Kill the real producer at its first Job read, after create ACKs but
      // before any Pod receipt. The next process must recover from disk alone.
      await assert.rejects(f.run("--preflight-only"), (error: unknown) => {
        assert.ok(error instanceof Error);
        if (mode === "interrupt-hard") {
          assert.ok("signal" in error && error.signal === "SIGKILL");
        } else {
          assert.ok("code" in error && error.code === 143);
        }
        return true;
      });
      const original = await preflightIdentities(f);
      assert.equal(original.length, 5);
      const lock = statSync(join(f.evidence, ".upgrade-lock"));
      const before = f.commands.length;
      await f.cleanup(...settlement);
      const { preflight } = await f.state();
      for (const kind of ["jobs", "pods", "secrets", "networkpolicies"] as const) {
        assert.deepEqual(preflight[kind], {});
      }
      assert.equal(preflight.deleted.length, 5);
      assert.deepEqual(await preflightIdentities(f), original, "preserve original ACK evidence");
      assert.ok(f.commands.slice(before).every((command) => command === "kubectl"));
      assert.equal(statSync(join(f.evidence, ".upgrade-lock")).ino, lock.ino);
      assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
      assert.equal(existsSync(join(f.evidence, "completed")), false);
      assert.deepEqual(await f.events(), [], "cleanup never deploys or stops writers");
      // Already-absent originals are a successful retry, not a new create.
      await f.cleanup(...settlement);
      assert.equal((await f.state()).preflight.deleted.length, 5);
      assert.equal(statSync(join(f.evidence, ".upgrade-lock")).ino, lock.ino);
    });
  }

  test("cleanup restart: settlement and original target are required before cluster access", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "secret", mode: "interrupt" },
    });
    await runForFailure(f, "--preflight-only");
    const before = f.commands.length;
    const original = await f.state();
    for (const flags of [[], [settlement[0]!], [settlement[1]!], [...settlement, "--resume"]]) {
      const failure = await runForFailure({ run: (...args) => f.cleanup(...args) }, ...flags);
      assert.equal(failure.code, 2);
    }
    const kubeconfig = join(f.directory, "kubeconfig");
    const bytes = await readFile(kubeconfig);
    await writeFile(kubeconfig, "different-cluster-config");
    const failure = await runForFailure({ run: (...args) => f.cleanup(...args) }, ...settlement);
    assert.equal(failure.code, 2);
    assert.equal(f.commands.length, before, "invalid local evidence never reaches kubectl");
    assert.deepEqual(await f.state(), original);
    await writeFile(kubeconfig, bytes);
    await f.cleanup(...settlement);
  });

  test("cleanup restart: a lost Job ACK preserves dependencies and never adopts the current UID", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "worker", mode: "lost" },
    });
    await runForFailure(f, "--preflight-only");
    const original = (await f.state()).preflight;
    const [unknown] = Object.values(original.jobs);
    assert.ok(unknown);
    assert.ok(
      !(await preflightIdentities(f)).some((record) => record.uid === unknown.metadata.uid),
    );
    // The earlier EXIT cleanup may already have removed the acknowledged API
    // Job. Neither that absence nor a live GET authorizes adopting the lost ACK.
    const failure = await runForFailure({ run: (...args) => f.cleanup(...args) }, ...settlement);
    assert.equal(failure.code, 1);
    const after = (await f.state()).preflight;
    assert.deepEqual(after.jobs, original.jobs);
    assert.deepEqual(after.pods, original.pods);
    assert.deepEqual(after.secrets, original.secrets);
    assert.deepEqual(after.networkpolicies, original.networkpolicies);
    assert.deepEqual(after.deleted, original.deleted);
    assert.deepEqual(await f.events(), []);
  });

  for (const [mode, when] of [
    ["replacement", "before DELETE"],
    ["replacement-after-delete", "after accepted DELETE"],
  ] as const) {
    test(`cleanup restart: a same-name Job replacement ${when} keeps dependencies`, async (t) => {
      const f = await fixture(t, {
        controllerOnly: true,
        preflightPolicy: true,
        preflightFault: { target: "secret", mode: "interrupt" },
      });
      await runForFailure(f, "--preflight-only");
      const path = join(f.directory, "state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state.preflightFault = { target: "migration", mode };
      await writeFile(path, JSON.stringify(state));
      const failure = await runForFailure({ run: (...args) => f.cleanup(...args) }, ...settlement);
      assert.equal(failure.code, 1, failure.stderr);
      const { preflight } = await f.state();
      const [replacement] = Object.values(preflight.jobs);
      assert.ok(replacement?.foreign);
      assert.ok(
        !(await preflightIdentities(f)).some((record) => record.uid === replacement.metadata.uid),
      );
      assert.equal(preflight.deleted.length, mode === "replacement" ? 2 : 3);
      assert.equal(Object.keys(preflight.secrets).length, 1);
      assert.equal(Object.keys(preflight.networkpolicies).length, 1);
      const marker = replacement.metadata.annotations?.fixture;
      assert.ok(marker);
      assert.ok(!(failure.stdout + failure.stderr).includes(marker));
      await assertCleanupOmitsMarker(f.evidence, marker);
      assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
      assert.deepEqual(await f.events(), []);
    });
  }

  test("cleanup ownership: a recorded child replacement after accepted Job DELETE keeps dependencies", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "migration", mode: "child-replacement-after-delete" },
    });
    // Normal preflight records the original child before cleanup. The fixture
    // replaces it only after DELETE accepts its owner Job, with a foreign owner
    // and no discovery label, so the saved child name must fail closed on UID.
    const failure = await runForFailure(f, "--preflight-only");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /startup preflight cleanup is incomplete/);
    const { preflight } = await f.state();
    assert.deepEqual(preflight.jobs, {});
    const children = Object.values(preflight.pods);
    assert.equal(children.length, 1);
    const [replacement] = children;
    assert.ok(replacement);
    const recorded = (await preflightIdentities(f)).find(
      (record) => record.kind === "pod" && record.name === replacement.metadata.name,
    );
    assert.ok(recorded, "the original child was acknowledged before its replacement");
    assert.notEqual(replacement.metadata.uid, recorded.uid);
    assert.deepEqual(replacement.metadata.labels, {});
    const marker = replacement.metadata.annotations?.fixture;
    assert.ok(marker);
    assert.ok(!(failure.stdout + failure.stderr).includes(marker));
    await assertCleanupOmitsMarker(f.evidence, marker);
    assert.equal(preflight.deleted.length, 3, "only original Jobs were deleted");
    assert.equal(Object.keys(preflight.secrets).length, 1);
    assert.equal(Object.keys(preflight.networkpolicies).length, 1);
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    assert.deepEqual(await f.events(), []);
  });

  test("cleanup restart: an unrecorded child with changed labels retains dependencies", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "secret", mode: "interrupt" },
    });
    await runForFailure(f, "--preflight-only");
    const path = join(f.directory, "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    const api = (await preflightIdentities(f)).find((record) => record.name.includes("-api-"));
    assert.ok(api);
    const child = Object.values((await f.state()).preflight.pods).find((pod) =>
      pod.metadata.ownerReferences?.some((owner) => owner.uid === api.uid),
    );
    assert.ok(child);
    // A controller-created child may precede its observer receipt. Label
    // changes must not conceal that consumer from the restarted cleanup.
    delete state.preflight.pods[child.metadata.name].metadata.labels;
    state.preflightFault = { target: "api", mode: "retained-child" };
    await writeFile(path, JSON.stringify(state));
    const failure = await runForFailure({ run: (...args) => f.cleanup(...args) }, ...settlement);
    assert.equal(failure.code, 1);
    const { preflight } = await f.state();
    assert.deepEqual(preflight.jobs, {});
    assert.equal(Object.keys(preflight.pods).length, 1);
    assert.equal(Object.keys(preflight.secrets).length, 1);
    assert.equal(Object.keys(preflight.networkpolicies).length, 1);
    // Explicitly model later external settlement, then retry the same journal.
    const settled = JSON.parse(await readFile(path, "utf8"));
    delete settled.preflight.pods[child.metadata.name];
    await writeFile(path, JSON.stringify(settled));
    await f.cleanup(...settlement);
    assert.deepEqual((await f.state()).preflight.secrets, {});
    assert.deepEqual((await f.state()).preflight.networkpolicies, {});
    assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
    assert.deepEqual(await f.events(), []);
  });

  test("cleanup ownership: already absent originals permit verified completion", async (t) => {
    for (const target of ["api", "secret", "networkpolicy.networking.k8s.io"] as const) {
      await t.test(target, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          preflightPolicy: true,
          preflightFault: { target, mode: "already-absent" },
        });
        // Another actor removes the original before DELETE reaches the API.
        // Its NotFound reply must still lead to verified consumer/dependency absence.
        await f.run("--preflight-only");
        const { preflight } = await f.state();
        for (const kind of ["jobs", "pods", "secrets", "networkpolicies"] as const) {
          assert.deepEqual(preflight[kind], {});
        }
        assert.equal(preflight.deleted.length, 4);
        assert.ok(existsSync(join(f.evidence, "startup-preflight-passed")));
        assert.deepEqual(await f.events(), [], "cleanup never stops OCC writers");
      });
    }
  });

  test("cleanup ownership: absent original Job still waits for its child", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "api", mode: "absent-job-retained-child" },
    });
    // The Job's NotFound reply does not establish that its original Pod stopped.
    const failure = await runForFailure(f, "--preflight-only");
    assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
    const { preflight } = await f.state();
    assert.deepEqual(preflight.jobs, {});
    assert.equal(Object.keys(preflight.pods).length, 1);
    assert.equal(Object.keys(preflight.secrets).length, 1);
    assert.equal(Object.keys(preflight.networkpolicies).length, 1);
    assert.match(
      await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8"),
      /Timed out stopping job\.batch\//,
    );
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    assert.deepEqual(await f.events(), []);
  });

  test("cleanup ownership: accepted dependency deletion waits for absence", async (t) => {
    for (const target of ["secret", "networkpolicy.networking.k8s.io"] as const) {
      await t.test(target, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          preflightPolicy: true,
          preflightFault: { target, mode: "delayed-delete" },
        });
        // DELETE is accepted while a finalizer still retains the original.
        // The fixture removes it only after later GETs observe that pending state.
        await f.run("--preflight-only");
        const { preflight } = await f.state();
        assert.deepEqual(preflight.secrets, {});
        assert.deepEqual(preflight.networkpolicies, {});
        assert.ok(existsSync(join(f.evidence, "startup-preflight-passed")));
        assert.deepEqual(await f.events(), []);
      });
    }
  });

  test("cleanup ownership: retained dependency blocks successful preflight", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "secret", mode: "retained-dependency" },
    });
    const failure = await runForFailure(f, "--preflight-only");
    assert.match(failure.stderr, /startup preflight cleanup is incomplete/);
    const { preflight } = await f.state();
    assert.deepEqual(preflight.jobs, {});
    assert.deepEqual(preflight.pods, {});
    assert.equal(Object.keys(preflight.secrets).length, 1);
    const [secret] = Object.values(preflight.secrets);
    assert.ok(secret);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.evidence, "preflight-cleanup-dependency.json"), "utf8")),
      { metadata: { uid: secret.metadata.uid } },
      "pending deletion evidence contains identity only",
    );
    assert.deepEqual(preflight.networkpolicies, {});
    assert.match(
      await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8"),
      /Timed out deleting secret\//,
    );
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    assert.deepEqual(await f.events(), []);
  });

  test("cleanup ownership: replacement Secret contents never enter cleanup evidence", async (t) => {
    for (const mode of ["replacement", "replacement-after-delete"] as const) {
      await t.test(mode, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          preflightPolicy: true,
          preflightFault: { target: "secret", mode },
        });
        // Check both a refused UID-guarded DELETE and replacement before the
        // first observation after an accepted DELETE. Neither permits retaining
        // Secret contents in cleanup evidence.
        const failure = await runForFailure(f, "--preflight-only");
        const { preflight } = await f.state();
        const [replacement] = Object.values(preflight.secrets);
        assert.ok(replacement);
        const original = (await preflightIdentities(f)).find((record) => record.kind === "secret");
        assert.ok(original);
        assert.notEqual(replacement.metadata.uid, original.uid);
        const encoded = replacement.data.credential;
        assert.ok(encoded);
        const marker = Buffer.from(encoded, "base64").toString("utf8");
        const output = failure.stdout + failure.stderr;
        assert.ok(!output.includes(marker) && !output.includes(encoded));
        for (const name of await readdir(f.evidence)) {
          if (!name.startsWith("preflight-cleanup")) {
            continue;
          }
          const text = await readFile(join(f.evidence, name), "utf8");
          assert.ok(
            !text.includes(marker) && !text.includes(encoded),
            `${name} excludes Secret contents`,
          );
        }
        assert.deepEqual(
          JSON.parse(await readFile(join(f.evidence, "preflight-cleanup-dependency.json"), "utf8")),
          { metadata: { uid: replacement.metadata.uid } },
        );
        assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
        assert.deepEqual(await f.events(), []);
      });
    }
  });

  test("cleanup ownership: acknowledged identities survive a real interruption", async (t) => {
    // Valid opaque UIDs need not be UUIDs, safe filenames, or unescaped JSON strings.
    const uid = '../opaque/"\\雪;$(value)';
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "secret", mode: "interrupt", uid },
      preflightResults: {
        api: { phase: "Succeeded", log: "installation-startup-ready\n" },
        worker: { phase: "Succeeded", log: "installation-startup-ready\n" },
      },
    });
    const failure = await runForFailure(f);
    assert.equal(failure.code, 143);
    assert.match(failure.stderr, /upgrade interrupted/);
    assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
    const state = await f.state();
    const records = await preflightIdentities(f);
    assert.equal(records.length, 5);
    assert.equal(statSync(f.evidence).mode & 0o777, 0o700);
    assert.ok(!(await readdir(f.evidence)).some((name) => name.endsWith("-identity.json.tmp")));
    assert.deepEqual(records, state.preflight.created);
    const secretIdentity = records.find((record) => record.kind === "secret");
    assert.ok(secretIdentity);
    assert.equal(secretIdentity.uid, uid);
    assert.equal(new Set(records.map((record) => record.uid)).size, 5);
    assert.deepEqual(state.preflight.deleted, []);
    const [secret] = Object.values(state.preflight.secrets);
    assert.ok(secret);
    for (const value of Object.values(secret.data)) {
      assert.ok(!JSON.stringify(records).includes(value), "no Secret data in identity evidence");
    }
    assert.deepEqual(await f.events(), []);
  });

  test("cleanup ownership: local publication failure retains guarded cleanup", async (t) => {
    for (const mode of ["evidence-file", "evidence-symlink"] as const) {
      await t.test(mode, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          preflightPolicy: true,
          preflightFault: { target: "secret", mode },
        });
        const failure = await runForFailure(f);
        assert.equal(failure.code, 1);
        assert.match(
          failure.stderr,
          /create acknowledged, but local identity evidence could not be confirmed/,
        );
        assert.doesNotMatch(failure.stderr, /ownership unconfirmed|Traceback|unrelated sentinel/);
        assert.ok(!failure.stderr.includes(f.evidence), "no local path in the diagnostic");
        const state = await f.state();
        assert.deepEqual(state.preflight.secrets, {});
        assert.equal(state.preflight.deleted.length, 2);
        assert.ok(state.preflight.created);
        assert.equal(state.preflight.created.length, 2, "stops before creating Jobs");
        const destination = join(f.evidence, "preflight-secret-identity.json");
        assert.equal(await readFile(destination, "utf8"), "unrelated sentinel");
        if (mode === "evidence-symlink") {
          assert.equal(
            await readFile(join(f.directory, "unrelated"), "utf8"),
            "unrelated sentinel",
          );
        }
        assert.ok(!(await readdir(f.evidence)).some((name) => name.endsWith("-identity.json.tmp")));
        assert.deepEqual(await f.events(), []);
      });
    }
  });

  // kubectl's create output stays off the terminal but is kept in the private evidence
  // directory, so an operator can tell a refusal from a lost or unusable acknowledgement.
  for (const [target, mode, acknowledged, errors, reason, kubectlOutput] of [
    [
      "networkpolicy.networking.k8s.io",
      "conflict",
      0,
      "preflight-networkpolicy-create.err",
      "kubectl reported an error for the create; see preflight-networkpolicy-create.err in the evidence directory.",
      /^Error from server \(AlreadyExists\): networkpolicies "[^"]+" already exists$/m,
    ],
    [
      "secret",
      "lost",
      1,
      "preflight-secret-create.err",
      "kubectl reported an error for the create; see preflight-secret-create.err in the evidence directory.",
      /^create acknowledgement lost: private-response-marker$/m,
    ],
    // The Secret's create ends a pipeline, so its status reaches the message as that pipeline's.
    [
      "secret",
      "empty",
      1,
      "preflight-secret-create.err",
      "The create returned no usable UID; kubectl's error output, if any, is in preflight-secret-create.err in the evidence directory.",
      /^$/,
    ],
    [
      "api",
      "empty",
      2,
      "preflight-api-job-create.err",
      "The create returned no usable UID; kubectl's error output, if any, is in preflight-api-job-create.err in the evidence directory.",
      /^$/,
    ],
    // Bash command substitution would otherwise strip this invalid receipt's newline.
    [
      "worker",
      "newline",
      3,
      "preflight-worker-job-create.err",
      "The create returned no usable UID; kubectl's error output, if any, is in preflight-worker-job-create.err in the evidence directory.",
      /^$/,
    ],
  ] as const) {
    test(`cleanup ownership: ${target} ${mode} preserves unconfirmed inventory`, async (t) => {
      const f = await fixture(t, {
        controllerOnly: true,
        preflightPolicy: true,
        preflightFault: { target, mode },
      });
      const failure = await runForFailure(f);
      const state = await f.state();
      const jobTarget = target === "api" || target === "worker";
      const inventory = jobTarget
        ? "jobs"
        : (
            {
              secret: "secrets",
              "networkpolicy.networking.k8s.io": "networkpolicies",
            } as const
          )[target];
      const remaining = Object.values<PreflightResource>(state.preflight[inventory]);
      assert.equal(remaining.length, 1, "the unconfirmed object survives");
      const [unconfirmed] = remaining;
      assert.ok(unconfirmed);
      const identities = await preflightIdentities(f);
      assert.equal(identities.length, acknowledged);
      assert.ok(!identities.some((record) => record.uid === unconfirmed.metadata.uid));
      if (jobTarget) {
        // An unacknowledged Job may still be running: preserve its mounted input and egress.
        assert.equal(Object.keys(state.preflight.secrets).length, 1);
        assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
        assert.equal(Object.keys(state.preflight.pods).length, 1);
        assert.equal(state.preflight.deleted.length, acknowledged - 2);
        assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
      } else {
        assert.equal(
          (["secrets", "pods", "jobs", "networkpolicies"] as const).flatMap((kind) =>
            Object.values<PreflightResource>(state.preflight[kind]),
          ).length,
          1,
          "only the unconfirmed object survives",
        );
        assert.equal(
          state.preflight.deleted.length,
          acknowledged,
          "acknowledged objects are cleaned",
        );
      }
      assert.equal(failure.code, 1);
      assert.ok(
        failure.stderr.includes(
          `/${unconfirmed.metadata.name}; no cleanup was attempted for this name. ${reason} Check whether`,
        ),
      );
      assert.match(
        failure.stderr,
        /Check whether this object remains in the selected namespace\. Correct the failure and use a fresh evidence directory\. This run stopped no OCC writer\./,
      );
      assert.match(await readFile(join(f.evidence, errors), "utf8"), kubectlOutput);
      assert.equal(statSync(join(f.evidence, errors)).mode & 0o777, 0o600);
      assert.ok(
        !failure.stderr.includes(unconfirmed.metadata.uid),
        "create response stays private",
      );
      assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
      assert.deepEqual(await f.events(), [], "no writer stops or migration");
    });
  }

  test("cleanup ownership: a Secret manifest kubectl quotes stays out of the evidence", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "secret", mode: "decode" },
    });
    const failure = await runForFailure(f);
    const state = await f.state();
    assert.equal(failure.code, 1);
    assert.match(
      failure.stderr,
      /ownership unconfirmed for secret\/[^;]+; no cleanup was attempted for this name\. kubectl reported an error for the create; see preflight-secret-create\.err in the evidence directory\./,
    );
    // kubectl refused before any request; only the NetworkPolicy existed and is cleaned.
    assert.deepEqual(state.preflight.secrets, {});
    assert.equal(state.preflight.deleted.length, 1);
    assert.equal((await preflightIdentities(f)).length, 1);
    // The diagnosis survives, but not the Installation bytes the Secret carried.
    const errors = await readFile(join(f.evidence, "preflight-secret-create.err"), "utf8");
    assert.match(errors, /^error: unable to decode "STDIN": Object 'Kind' is missing in '/);
    const installation = await readFile(join(f.evidence, "candidate-installation.yaml"));
    assert.ok(installation.length > 24, "the fixture Installation is long enough to redact");
    assert.ok(!errors.includes(installation.toString("base64")), "Secret data stays out");
    assert.match(errors, /\[redacted\]/);
    assert.deepEqual(await f.events(), []);
  });

  test("cleanup ownership: same-name replacement survives EXIT cleanup", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      // Replace the last Job so later cleanup reads cannot overwrite its evidence.
      preflightFault: { target: "migration", mode: "replacement" },
      preflightResults: {
        worker: { phase: "Failed", log: "primary startup failure\n" },
      },
    });
    const failure = await runForFailure(f);
    const state = await f.state();
    const jobs = Object.values(state.preflight.jobs);
    assert.equal(jobs.length, 1);
    const [replacement] = jobs;
    assert.ok(replacement);
    assert.equal(replacement.foreign, true);
    const marker = replacement.metadata.annotations?.fixture;
    assert.ok(marker, "the replacement carries an unrelated private annotation");
    for (const filename of await readdir(f.evidence)) {
      if (filename.startsWith("preflight-cleanup")) {
        const contents = await readFile(join(f.evidence, filename), "utf8");
        assert.ok(!contents.includes(marker), `${filename} excludes replacement Job contents`);
      }
    }
    assert.ok(!(failure.stdout + failure.stderr).includes(marker));
    assert.deepEqual(
      JSON.parse(await readFile(join(f.evidence, "preflight-cleanup-job.json"), "utf8")),
      { metadata: { uid: replacement.metadata.uid } },
    );
    const records = await preflightIdentities(f);
    assert.ok(state.preflight.created);
    assert.ok(state.preflight.children);
    assert.deepEqual(records, [...state.preflight.created, ...state.preflight.children]);
    const original = records.find((record) => record.name === replacement.metadata.name);
    assert.ok(original);
    assert.notEqual(original.uid, replacement.metadata.uid);
    assert.equal(state.preflight.deleted.length, 2, "the other acknowledged Jobs are cleaned");
    assert.equal(Object.keys(state.preflight.pods).length, 1, "the original Job child remains");
    assert.equal(Object.keys(state.preflight.secrets).length, 1);
    assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
    assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /primary startup failure/);
    // The warning says the identity did not match, and the API's answer stays private.
    assert.match(
      failure.stderr,
      /could not confirm cleanup of job\.batch\/[^:]+: an object with a different UID now holds this name, so it was left in place; see preflight-cleanup\.err in the evidence directory\./,
    );
    assert.match(
      await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8"),
      /^job\.batch\/[^\n]+-migration-[^\n]+:\nError from server \(Conflict\): .*Precondition failed: UID in precondition: /m,
    );
    assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
    assert.deepEqual(await f.events(), []);
  });

  test("cleanup ownership: a refused DELETE is reported as a failed request", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "secret", mode: "delete-refused" },
      preflightResults: {
        worker: { phase: "Failed", log: "primary startup failure\n" },
      },
    });
    const failure = await runForFailure(f);
    const state = await f.state();
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /primary startup failure/);
    assert.equal(Object.values(state.preflight.secrets).length, 1);
    assert.equal(state.preflight.deleted.length, 4, "cleanup continues for other owned objects");
    assert.match(
      failure.stderr,
      /could not confirm cleanup of secret\/[^:]+: the delete request failed; see preflight-cleanup\.err in the evidence directory\./,
    );
    assert.doesNotMatch(failure.stderr, /different UID/);
    const errors = await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8");
    assert.match(
      errors,
      /^secret\/[^\n]+:\nError from server \(Forbidden\): secrets "[^"]+" is forbidden: /m,
    );
    assert.equal(statSync(join(f.evidence, "preflight-cleanup.err")).mode & 0o777, 0o600);
    assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
    assert.deepEqual(await f.events(), []);
  });

  // Each refused DELETE appends its answer, so the first one is still there to read.
  test("cleanup ownership: every refused DELETE keeps its answer in the evidence", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "job.batch", mode: "delete-refused" },
      preflightResults: {
        worker: { phase: "Failed", log: "primary startup failure\n" },
      },
    });
    const failure = await runForFailure(f);
    const state = await f.state();
    assert.equal(failure.code, 1);
    assert.equal(Object.values(state.preflight.pods).length, 3);
    assert.equal(Object.keys(state.preflight.jobs).length, 3);
    assert.equal(Object.keys(state.preflight.secrets).length, 1);
    assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
    assert.deepEqual(state.preflight.deleted, []);
    assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
    const errors = await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8");
    for (const component of ["api", "worker", "migration"]) {
      assert.match(
        failure.stderr,
        new RegExp(
          `could not confirm cleanup of job\\.batch/[^:]+-${component}-[^:]+: the delete request failed;`,
        ),
      );
      assert.match(
        errors,
        new RegExp(
          `^job\\.batch/[^\\n]+-${component}-[^\\n]+:\\nError from server \\(Forbidden\\): jobs "`,
          "m",
        ),
      );
    }
    assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
  });

  // A label is discovery data, not proof that the selected Job controls this Pod.
  test("startup preflight refuses a label-matched Pod owned by another Job", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "api", mode: "foreign-child" },
    });
    const failure = await runForFailure(f, "--preflight-only");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /cannot establish the api startup preflight child Pod identity/);
    const state = await f.state();
    assert.equal(Object.keys(state.preflight.pods).length, 1, "the foreign Pod remains untouched");
    assert.equal(Object.keys(state.preflight.secrets).length, 1);
    assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
    const records = await preflightIdentities(f);
    assert.ok(!records.some((record) => record.name === Object.keys(state.preflight.pods)[0]));
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    assert.deepEqual(await f.events(), []);
  });

  // A successful DELETE response does not prove that all consumers have stopped.
  // This command fixture retains the child after accepting Job deletion; it does not
  // simulate Kubernetes garbage collection or establish live cluster behavior.
  test("startup preflight retains dependencies while an acknowledged Job child remains", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target: "api", mode: "retained-child" },
    });
    const failure = await runForFailure(f, "--preflight-only");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /startup preflight cleanup is incomplete/);
    assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
    const state = await f.state();
    assert.deepEqual(state.preflight.jobs, {});
    assert.equal(Object.keys(state.preflight.pods).length, 1);
    assert.equal(Object.keys(state.preflight.secrets).length, 1);
    assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
    assert.deepEqual(
      state.preflight.deleted.map((resource) => resource.split("/")[0]),
      ["job.batch", "job.batch", "job.batch"],
    );
    assert.match(
      await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8"),
      /Timed out stopping job\.batch\//,
    );
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    assert.deepEqual(await f.events(), []);
  });
}
