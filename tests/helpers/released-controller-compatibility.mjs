import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { redactLogLine } from "../../scripts/ci/failure-redaction.mjs";
import { settled } from "./child-processes.mjs";
import { withTestOwnerLabel } from "./docker-test-owner.mjs";

const exec = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const legacyOrigin = "http://127.0.0.1";
const sharedCookieOrigin = "https://console.oce.localhost";
const agentDomain = "agents.oce.localhost";
const bootstrapPrograms = [
  "scripts/bootstrap-installation.mjs",
  "scripts/bootstrap-installation.ts",
];
const processProgram = "released-controller-process.mts";
const bootstrapProbe = `
  import { lstatSync, readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync("/app/package.json", "utf8"));
  const program = ${JSON.stringify(bootstrapPrograms)}.find((path) =>
    manifest?.name === "openclaw-enterprise" &&
    manifest.scripts?.["db:bootstrap"] === "NODE_ENV=development node " + path &&
    manifest.scripts?.["db:bootstrap:production"] === "NODE_ENV=production node " + path
  );
  console.log(JSON.stringify(
    program && lstatSync("/app/" + program, { throwIfNoEntry: false })?.isFile() ? program : null
  ));
`;
const authProbe = `
  import { existsSync } from "node:fs";
  const configuration = "/app/apps/controller/src/auth/configuration.ts";
  console.log(JSON.stringify(
    existsSync(configuration) &&
    typeof (await import(configuration)).deriveSharedCookieDomain === "function"
  ));
`;
const authSecret = "local-compatibility-session-secret-32-bytes";

function normalizedRepositoryDigest(reference) {
  const match = /^([^@]+)@(sha256:[a-f0-9]{64})$/.exec(reference);
  if (!match) {
    return undefined;
  }
  const [, name, digest] = match;
  const tagSeparator = name.lastIndexOf(":");
  const repository = tagSeparator > name.lastIndexOf("/") ? name.slice(0, tagSeparator) : name;
  const slash = repository.indexOf("/");
  const first = slash === -1 ? "" : repository.slice(0, slash);
  const hasRegistry = first === "localhost" || /[.:A-Z]/.test(first);
  const registry = hasRegistry && first !== "index.docker.io" ? first : "docker.io";
  const path = hasRegistry ? repository.slice(slash + 1) : repository;
  const qualifiedPath = registry === "docker.io" && !path.includes("/") ? `library/${path}` : path;
  return `${registry}/${qualifiedPath}@${digest}`;
}

async function withReleasedControllerFixture(t, images, createDatabase, scenario) {
  const owner = `controller-compatibility-${randomUUID()}`;
  const label = `org.openclaw.compatibility=${owner}`;
  const children = [];
  const exits = [];
  const observations = [];
  async function command(args, { cleanup = false } = {}) {
    try {
      return await exec(docker, withTestOwnerLabel(docker, args), {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(cleanup ? {} : { signal: t.signal }),
      });
    } catch {
      // Docker errors embed argv, including the disposable database URL.
      throw new Error("Controller image command failed; no compatibility result.");
    }
  }
  for (const image of Object.values(images)) {
    const selectedIdentity = normalizedRepositoryDigest(image.reference);
    assert.ok(selectedIdentity, "Controller selection must include an immutable SHA-256 digest.");
    assert.match(image.revision, /^[a-f0-9]{40}$/);
    const inspected = JSON.parse((await command(["image", "inspect", image.reference])).stdout);
    assert.equal(inspected.length, 1);
    // Docker can shorten Docker Hub names and omit the tag in RepoDigests.
    assert.ok(
      inspected[0].RepoDigests.some(
        (value) => normalizedRepositoryDigest(value) === selectedIdentity,
      ),
      "Inspected controller digest differs from selection.",
    );
    assert.equal(inspected[0].Config.Labels["org.opencontainers.image.revision"], image.revision);
  }
  async function probe(image, source) {
    const result = await command([
      "run",
      "--rm",
      "--pull",
      "never",
      "--label",
      label,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      image,
      "--input-type=module",
      "--eval",
      source,
    ]);
    return JSON.parse(result.stdout);
  }
  // Only the released image bootstraps. Validate its direct entry point before
  // provisioning the database, so no discovery or retry can follow a write.
  const bootstrapProgram = await probe(images.released.reference, bootstrapProbe);
  assert.ok(
    bootstrapPrograms.includes(bootstrapProgram),
    "The released image must declare both Installation bootstrap tasks for the same supported regular file.",
  );
  const authByImage = new Map();
  for (const image of new Set(Object.values(images).map(({ reference }) => reference))) {
    const sharedCookies = await probe(image, authProbe);
    assert.equal(typeof sharedCookies, "boolean");
    authByImage.set(image, {
      OCC_AUTH_BASE_URL: sharedCookies ? sharedCookieOrigin : legacyOrigin,
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: agentDomain,
    });
  }
  const db = await createDatabase();
  const migrationUrl = new URL(db.migrationUrl);
  migrationUrl.hostname = "127.0.0.1";
  migrationUrl.port = "5432";
  const applicationUrl = new URL(migrationUrl);
  applicationUrl.username = "occ_app";
  applicationUrl.password = "occ-app-local";
  const base = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--label",
    label,
    "--network",
    `container:${db.container}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,mode=1777",
    "--tmpfs",
    "/bootstrap:rw,mode=700,uid=1000,gid=1000",
  ];
  const args = (image, program, environment = {}, extra = []) => [
    ...base,
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...extra,
    image.reference,
    program,
  ];
  const migrate = (image) =>
    command(
      args(image, "scripts/migrate-production.mjs", {
        NODE_ENV: "development",
        OCC_MIGRATION_DATABASE_URL: migrationUrl.toString(),
      }),
    );
  const history = async () =>
    (
      await db.migrator.query(
        "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id",
      )
    ).rows;
  async function start(image, role, { configuredIAM = false } = {}) {
    const name = `${owner}-${role}-${randomUUID().slice(0, 8)}`;
    const mounts = [
      processProgram,
      "development.ts",
      "default-users-iam.mjs",
      "secret-driver.ts",
    ].flatMap((file) => [
      "--mount",
      `type=bind,src=${fileURLToPath(new URL(file, import.meta.url))},dst=/proof/${file},readonly`,
    ]);
    const { OCC_AUTH_BASE_URL, OCC_AGENT_NATIVE_ADMIN_DOMAIN } = authByImage.get(image.reference);
    const child = spawn(
      docker,
      withTestOwnerLabel(
        docker,
        args(
          image,
          `/proof/${processProgram}`,
          {
            OCC_DATABASE_URL: applicationUrl.toString(),
            OCC_AUTH_BASE_URL,
            OCC_AGENT_NATIVE_ADMIN_DOMAIN,
            OCC_TEST_CONTROLLER_ROLE: role,
            ...(configuredIAM ? { OCC_TEST_CONTROLLER_IAM: "1" } : {}),
          },
          ["-i", "--name", name, ...mounts],
        ),
      ),
      { stdio: ["pipe", "pipe", "pipe"], signal: t.signal },
    );
    children.push(child);
    // Child close reports an early exit; EPIPE must not bypass owned cleanup.
    child.stdin.on("error", () => {});
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const pending = new Map();
    const received = new Map();
    let finished = false;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        return;
      }
      const key =
        result.response ?? (result.ready ? "ready" : result.shutdown ? "shutdown" : undefined);
      if (key === undefined) {
        return;
      }
      if (pending.has(key)) {
        pending.get(key).resolve(result);
      } else {
        received.set(key, result);
      }
    });
    const exit = new Promise((resolve) => {
      child.once("error", () => {
        if (child.pid === undefined) {
          resolve(-1);
        }
      });
      child.once("close", resolve);
    });
    exits.push(exit);
    void exit.then(() => {
      finished = true;
      for (const item of pending.values()) {
        item.reject(
          new Error(
            "Image-side controller exited before its response: " +
              stderr
                .split("\n")
                .map((line) =>
                  redactLogLine(
                    line,
                    [
                      [applicationUrl.toString(), "database"],
                      [authSecret, "session-secret"],
                      ["postgres-development-password", "password"],
                    ],
                    800,
                  ),
                )
                .join("\n"),
          ),
        );
      }
    });
    async function wait(key) {
      if (received.has(key)) {
        const result = received.get(key);
        received.delete(key);
        return result;
      }
      assert.equal(finished, false, "Image-side controller already exited.");
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(key, { resolve, reject });
          timer = setTimeout(
            () => reject(new Error("Image-side controller response deadline.")),
            60_000,
          );
        });
      } finally {
        clearTimeout(timer);
        pending.delete(key);
      }
    }
    const ready = await wait("ready");
    const containerId = (await command(["inspect", "--format", "{{.Id}}", name])).stdout.trim();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const processIdentity = { containerId, pid: ready.pid, accountId: ready.accountId };
    return {
      identity: processIdentity,
      async request(phase, op, fields = {}) {
        const id = randomUUID();
        child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
        const result = await wait(id);
        observations.push({ phase, role, process: processIdentity, op, ...result });
        t.diagnostic(JSON.stringify(observations.at(-1)));
        return result;
      },
      async stop() {
        child.stdin.end('{"op":"stop"}\n');
        await wait("shutdown");
        let timer;
        try {
          assert.equal(
            await Promise.race([
              exit,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Image-side shutdown deadline.")),
                  30_000,
                );
              }),
            ]),
            0,
          );
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
  try {
    await migrate(images.released);
    const before = await history();
    assert.ok(before.length > 0);
    await command(
      args(images.released, `/app/${bootstrapProgram}`, {
        NODE_ENV: "development",
        OCC_DATABASE_URL: applicationUrl.toString(),
        OCC_AUTH_SECRET: authSecret,
        ...authByImage.get(images.released.reference),
        OPENCLAW_DEV_EMAIL: "postgres-admin@openclaw.local",
        OPENCLAW_DEV_PASSWORD: "postgres-development-password",
        OCC_BOOTSTRAP_SERVICE_KEY_FILE: "/bootstrap/service-key.json",
      }),
    );
    t.diagnostic(JSON.stringify({ phase: "released-bootstrap", program: bootstrapProgram }));
    await scenario({
      start,
      migrate,
      history,
      before,
      args,
      command,
      observations,
      db,
      migrationUrl,
    });
  } finally {
    // Reuse the repository owner label for interruption cleanup, and remove only
    // this case's remaining containers before its existing database owner drops it.
    const ids = (
      await command(["ps", "-aq", "--filter", `label=${label}`], { cleanup: true })
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length > 0) {
      await command(["rm", "-f", ...ids], { cleanup: true });
    }
    for (const child of children) {
      child.stdin.destroy();
    }
    let timer;
    try {
      await Promise.race([
        settled(exits),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Owned image processes did not close after container removal.")),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function assertReleasedControllerCompatibility(t, images, createDatabase) {
  await withReleasedControllerFixture(
    t,
    images,
    createDatabase,
    async ({ start, migrate, history, before, args, command, observations, migrationUrl }) => {
      let released = await start(images.released, "released");
      const namespace = await released.request("before-migration", "work", {
        name: "Before migration",
      });
      const reads = [
        await released.request("before-migration", "read", { namespaceId: namespace.namespaceId }),
      ];
      // Keep the real old worker alive while the canonical candidate migrator runs.
      // This does not assert overlap with an individual DDL statement.
      await settled([
        migrate(images.candidate),
        released.request("during-migration", "work", { name: "During migration" }),
      ]);
      const after = await history();
      assert.deepEqual(after.slice(0, before.length), before);
      await released.request("after-migration", "work", { name: "After migration" });
      await released.stop();
      released = await start(images.released, "released");
      await released.request("restarted-old", "work", { name: "After restart" });
      reads.push(
        await released.request("restarted-old", "read", { namespaceId: namespace.namespaceId }),
      );
      const candidate = await start(images.candidate, "candidate");
      const saved = await candidate.request("candidate-write", "connection", {
        namespaceId: namespace.namespaceId,
      });
      await candidate.stop();
      reads.push(
        await released.request("after-candidate-write", "read", {
          namespaceId: namespace.namespaceId,
        }),
      );
      await released.request("after-candidate-write", "work", { name: "After candidate writes" });
      await released.stop();
      released = await start(images.released, "released");
      reads.push(
        await released.request("restarted-after-candidate-write", "read", {
          namespaceId: namespace.namespaceId,
        }),
      );
      await released.request("restarted-after-candidate-write", "work", {
        name: "Restart after candidate writes",
      });
      await released.stop();
      const checked = await command([
        ...args(images.candidate, "scripts/migrate-production.mjs", {
          NODE_ENV: "development",
          OCC_MIGRATION_DATABASE_URL: migrationUrl.toString(),
        }),
        "--check",
      ]);
      const checkEvents = checked.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(
        checkEvents.some(
          (event) => event.event === "migration.checked" && event.history === "completed",
        ),
      );
      assert.deepEqual(
        await history(),
        after,
        "Read-only migration check must preserve the receipt chain.",
      );
      t.diagnostic(
        JSON.stringify({
          images,
          beforeReceipts: before.length,
          afterReceipts: after.length,
          candidateHistoryCheck: "completed",
          observations,
        }),
      );
      assert.deepEqual(
        reads.map(({ status, errorCode }) => ({ status, errorCode })),
        reads.map(() => ({ status: 200, errorCode: null })),
        "Released controller must still read supported candidate writes, including after restart.",
      );
      for (const read of reads.slice(-2)) {
        assert.ok(
          read.listedSourceIds.includes(saved.sourceId),
          "Released controller must list the exact candidate-created credential source, including after restart.",
        );
      }
    },
  );
}

export async function assertReleasedControllerIAMCompatibility(t, images, createDatabase) {
  let qualified = false;
  try {
    await withReleasedControllerFixture(
      t,
      images,
      createDatabase,
      async ({ start, migrate, history, before, db }) => {
        const released = await start(images.released, "released");
        const allowed = await released.request("before-migration", "work", {
          name: "Compatibility allowed",
        });
        const outside = await released.request("before-migration", "work", {
          name: "Compatibility outside",
        });
        const read = (process, phase) =>
          process.request(phase, "namespace", {
            namespaceId: allowed.namespaceId,
          });
        assert.equal((await read(released, "before-migration")).status, 200);

        // SQL permits a new policy shape but does not create it. Keep the old process and
        // session alive to distinguish migration compatibility from candidate startup writes.
        await migrate(images.candidate);
        const after = await history();
        assert.deepEqual(after.slice(0, before.length), before);
        t.diagnostic(
          JSON.stringify({
            phase: "after-migration",
            beforeReceipts: before.length,
            afterReceipts: after.length,
          }),
        );
        assert.equal((await read(released, "after-sql-before-policy")).status, 200);
        const candidate = await start(images.candidate, "candidate", { configuredIAM: true });
        assert.equal(candidate.identity.accountId, released.identity.accountId);
        const policy = await db.migrator.query(`
        SELECT b.namespace_id, g.namespace_id AS group_namespace_id
        FROM occ.iam_access_bindings b JOIN occ.iam_groups g ON g.id = b.group_subject_id
        WHERE g.id = 'group_config_default-user' AND b.role_id = 'role_config_agent_creator'
      `);
        assert.deepEqual(policy.rows, [
          { namespace_id: allowed.namespaceId, group_namespace_id: null },
        ]);
        t.diagnostic(JSON.stringify({ phase: "candidate-policy-active", bindings: policy.rows }));
        const candidateRead = await read(candidate, "after-policy");
        const oldRead = await read(released, "after-policy");
        const member = await candidate.request("after-policy", "member-controls", {
          namespaceId: allowed.namespaceId,
          outsideId: outside.namespaceId,
        });
        await candidate.stop();
        await released.stop();

        // Also try a cold old worker. A rejected startup is failed compatibility, but retain
        // it beside the live read so the first symptom does not hide the recovery boundary.
        let restartError;
        let restartedRead;
        try {
          const restarted = await start(images.released, "released");
          assert.equal(restarted.identity.accountId, released.identity.accountId);
          restartedRead = await read(restarted, "restarted-after-policy");
          await restarted.stop();
        } catch (error) {
          restartError = error;
          t.diagnostic(JSON.stringify({ phase: "restarted-after-policy", error: error.message }));
        }
        assert.equal(candidateRead.status, 200, "Candidate administrator must remain authorized.");
        assert.deepEqual(
          member.results.map(({ status }) => status),
          [200, 403],
          "Default user must be confined to the configured Namespace.",
        );
        assert.equal(
          oldRead.status,
          200,
          "Released administrator must remain authorized after candidate policy activation.",
        );
        assert.equal(
          restartError,
          undefined,
          "Released controller must restart after candidate policy activation.",
        );
        assert.equal(restartedRead.status, 200, "Restarted administrator must remain authorized.");
      },
    );
    qualified = true;
  } finally {
    t.diagnostic(JSON.stringify({ scenario: "configured-iam", images, qualified }));
  }
}
