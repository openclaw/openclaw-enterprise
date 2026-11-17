import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { lstat, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { servedAs } from "../helpers/agent-identity.mjs";
import { withGatewaySecurityDefaults } from "../helpers/admitted-configuration.mjs";

type Fixture = {
  directory: string;
  engineLog: string;
  env: NodeJS.ProcessEnv;
};

type LifecycleDependencies = {
  k3dFixture: (
    t: TestContext,
    sandboxDriver?: string,
    handleRequest?: RequestListener,
  ) => Promise<Fixture>;
  runFirstAgentAsync: (env: NodeJS.ProcessEnv, ...args: string[]) => Promise<string>;
  firstAgent: string;
  repository: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

export function registerFirstAgentFailureAdviceCases({
  k3dFixture,
  runFirstAgentAsync,
}: LifecycleDependencies): void {
  test("first-Agent deployment failure advice follows the reported cause", async (t) => {
    for (const code of [
      "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE",
      "RUNTIME_AUTHENTICATION_FAILED",
      "RUNTIME_STARTUP_FAILED",
    ]) {
      await t.test(code, async (t) => {
        const suffix = "00000000-0000-4000-8000-000000000001";
        const installationId = `ins_${suffix}`;
        const namespaceId = `ns_${suffix}`;
        const agentId = `agt_${suffix}`;
        const configurationId = `cfg_${suffix}`;
        const revisionId = `rev_${suffix}`;
        const base = `/namespaces/${namespaceId}`;
        const agentPath = `${base}/agents/${agentId}`;
        const name = "state-contract-test";
        const secret = {
          id: `sec_${suffix}`,
          name: "saved-model-key",
          ref: { kind: "secret", namespaceId: namespaceId, id: `sec_${suffix}` },
        };
        let configuration: Record<string, unknown> | undefined;
        let agent: Record<string, unknown> | undefined;
        let revision: Record<string, unknown> | undefined;
        let source: Record<string, unknown> | undefined;
        let role: Record<string, unknown> | undefined;
        let binding: Record<string, unknown> | undefined;
        let transportConfigured = false;
        let interruptBeforeTransport = code === "RUNTIME_STARTUP_FAILED";
        let deploymentReads = 0;
        const unexpected: string[] = [];
        // Run the real helper and HTTP client against supported API envelopes. The
        // fixture supplies deployment evidence, not policy or credential decisions;
        // this does not exercise a controller, database, cluster, or model provider.
        const { directory, engineLog, env } = await k3dFixture(
          t,
          "openshell",
          async (request, response) => {
            const chunks: Buffer[] = [];
            const requestBody: AsyncIterable<unknown> = request;
            for await (const chunk of requestBody) {
              assert.ok(Buffer.isBuffer(chunk));
              chunks.push(chunk);
            }
            const body = chunks.length
              ? record(JSON.parse(Buffer.concat(chunks).toString()))
              : undefined;
            let data: Record<string, unknown> | Record<string, unknown>[] | undefined;
            let status = 200;
            const meta: { requestId: string; nextCursor?: null } = { requestId: `req_${suffix}` };
            switch (`${request.method} ${request.url}`) {
              case "GET /installation":
                data = { id: installationId };
                break;
              case "GET /namespaces":
                data = [{ id: namespaceId, name: "default" }];
                break;
              case `GET ${base}`:
                data = { id: namespaceId, status: "ready" };
                break;
              case `GET ${base}/agents`:
                data = agent ? [agent] : [];
                break;
              case `GET ${base}/credential-sources`:
                data = source ? [source] : [];
                break;
              case `GET ${base}/iam/roles`:
                data = role ? [role] : [];
                break;
              case `GET ${base}/iam/access-bindings`:
                data = binding ? [binding] : [];
                break;
              case `GET ${base}/secrets/${secret.id}`:
                data = secret;
                break;
              case `POST ${base}/credential-sources`:
                status = 201;
                source = { ...body, id: `cs_${suffix}`, state: "ready" };
                data = source;
                break;
              case `POST ${base}/configurations`:
                status = 201;
                configuration = {
                  ...body,
                  id: configurationId,
                  namespaceId: namespaceId,
                  generation: 1,
                };
                data = configuration;
                break;
              case `GET ${base}/configurations/${configurationId}`:
                data = configuration;
                break;
              case `POST ${base}/agents`:
                status = 201;
                agent = {
                  ...body,
                  id: agentId,
                  namespaceId: namespaceId,
                  servicePrincipalId: "sp_agent",
                  backendId: null,
                  activeRevisionId: null,
                  desiredRuntimeState: "stopped",
                };
                data = agent;
                break;
              case `GET ${agentPath}`:
                data = agent;
                break;
              case `POST ${base}/iam/roles`:
                status = 201;
                role = { ...body, id: "role_test" };
                data = role;
                break;
              case `POST ${base}/iam/access-bindings`:
                status = 201;
                binding = { ...body, id: "binding_test" };
                data = binding;
                break;
              case `GET ${agentPath}/runtime-credentials`:
                if (interruptBeforeTransport) {
                  response.writeHead(503, { "content-type": "application/json" });
                  response.end(JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE" }, meta }));
                  return;
                }
                data = { transportConfigured };
                break;
              case `POST ${agentPath}/runtime-credentials`:
                transportConfigured = true;
                data = { transportConfigured };
                break;
              case `GET ${agentPath}/revisions?limit=1`:
                data = revision ? [{ id: revision.id }] : [];
                meta.nextCursor = null;
                break;
              case `POST ${agentPath}/deploy`: {
                status = 202;
                assert.ok(agent);
                assert.ok(configuration);
                agent.desiredRuntimeState = "running";
                // Model the admitted snapshot from the helper's actual Configuration,
                // including the existing OpenShell workspace and permission settings.
                const servedConfiguration: unknown = servedAs(
                  record(structuredClone(configuration.values)),
                  name,
                );
                const values = record(withGatewaySecurityDefaults(record(servedConfiguration)));
                record(record(values.agents).defaults).workspace = "/sandbox/enterprise";
                const appServer = record(
                  record(record(record(record(values.plugins).entries).codex).config).appServer,
                );
                appServer.sandbox = "danger-full-access";
                appServer.approvalsReviewer = "user";
                revision = {
                  id: revisionId,
                  agentId: agent.id,
                  namespaceId: namespaceId,
                  configurationId: configuration.id,
                  configurationKind: "agent",
                  configurationGeneration: 1,
                  configuration: {
                    ...values,
                    logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
                    diagnostics: { otel: { logs: false } },
                  },
                  harness: { id: "codex", mode: "dedicated" },
                  harnessAuth: agent.harnessAuth,
                  backendId: null,
                };
                data = revision;
                break;
              }
              case `GET ${agentPath}/revisions/${revisionId}`:
                data = revision;
                break;
              case `GET ${agentPath}/deployments/${revisionId}`:
                deploymentReads++;
                assert.ok(agent);
                assert.ok(revision);
                data = {
                  namespaceId: namespaceId,
                  agentId: agent.id,
                  deploymentId: revision.id,
                  status: "failed",
                  cleanup: null,
                  progress: null,
                  warnings: [],
                  error: { code, message: "private-provider-message" },
                };
                break;
              default:
                unexpected.push(`${request.method} ${request.url}`);
            }
            response.writeHead(data === undefined ? 404 : status, {
              "content-type": "application/json",
            });
            response.end(
              JSON.stringify(
                data === undefined ? { error: { code: "NOT_FOUND" }, meta } : { data, meta },
              ),
            );
          },
        );
        const keyPath = join(directory, "initial-admin-service-key.json");
        const key = record(JSON.parse(await readFile(keyPath, "utf8")));
        record(key.meta).installationId = installationId;
        await writeFile(keyPath, JSON.stringify(key));
        // Resume an interrupted run after it saved its Secret. No model credential
        // is needed or read, and the real helper creates the remaining resources.
        const recordPath = join(
          directory,
          `first-agent-${createHash("sha256").update(name).digest("hex").slice(0, 32)}.json`,
        );
        await writeFile(
          recordPath,
          JSON.stringify({
            version: 3,
            name,
            namespaceId: namespaceId,
            model: "fixture-model",
            harness: "codex",
            sandboxDriver: "openshell",
            controlUi: false,
            authMethod: "codex_pat",
            secretId: secret.id,
            secretName: secret.name,
            credentialSourceName: "saved-model-source",
          }),
          { mode: 0o600 },
        );
        for (const key of [
          "OPENCLAW_FIRST_AGENT_MODEL",
          "OPENAI_API_KEY",
          "OPENAI_API_KEY_FILE",
          "CODEX_ACCESS_TOKEN",
          "CODEX_ACCESS_TOKEN_FILE",
        ]) {
          delete env[key];
        }
        // The saved Secret is reused; parent model credentials must never reach kubectl.
        env.CODEX_ACCESS_TOKEN = "synthetic-parent-model-token";
        env.CODEX_ACCESS_TOKEN_FILE = join(directory, "unused-model-token");
        if (interruptBeforeTransport) {
          // Stop after the draft Agent was saved. A later controller outage must
          // refuse its retry before creating the missing transport credentials.
          await runFirstAgentAsync(env, "--harness", "codex");
          const draft = record(JSON.parse(await readFile(recordPath, "utf8")));
          assert.equal(draft.agentId, agentId);
          assert.equal(draft.revisionId, undefined);
          assert.equal(transportConfigured, false);
          interruptBeforeTransport = false;
          const refused = await runFirstAgentAsync(
            { ...env, FIRST_AGENT_TEST_CONTROLLER_UNAVAILABLE: "1" },
            "--harness",
            "codex",
          );
          assert.match(refused, /Agent Sandbox controller readiness could not be verified/);
          assert.equal(
            transportConfigured,
            false,
            "refused draft retry must not create credentials",
          );
        }
        const output = await runFirstAgentAsync(env, "--harness", "codex");
        assert.match(output, new RegExp(`The Agent deployment failed \\(${code}\\)`));
        assert.doesNotMatch(output, /private-provider-message/);
        if (code === "RUNTIME_AUTHENTICATION_FAILED") {
          assert.match(output, /Check the model key.*--replace-key/);
        } else {
          assert.doesNotMatch(output, /Check the model key|--replace-key/);
          if (code === "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE") {
            assert.match(output, /managed permission policy.*incompatible/);
            assert.match(output, /sandbox.*permission profile.*approval reviewer/);
          } else {
            assert.match(
              output,
              /Inspect the deployment in the Console and the controller worker logs/,
            );
          }
        }
        assert.equal(deploymentReads, 1, "terminal failure stops polling immediately");
        // A later controller outage must not hide the saved revision's own failure.
        // This is the repeat path; it reads the existing deployment without provisioning.
        const repeated = await runFirstAgentAsync(
          { ...env, FIRST_AGENT_TEST_CONTROLLER_UNAVAILABLE: "1" },
          "--harness",
          "codex",
        );
        assert.ok(repeated.includes(`The Agent deployment failed (${code})`), repeated);
        assert.doesNotMatch(repeated, /Checking the managed Agent Sandbox controller/);
        assert.equal(deploymentReads, 2);
        assert.deepEqual(unexpected, [], "no runtime or model request follows failed deployment");
        await assert.rejects(readFile(engineLog), { code: "ENOENT" });
      });
    }
  });
}

export function registerFirstAgentLockAndRecordCases({
  k3dFixture,
  runFirstAgentAsync,
  firstAgent,
  repository,
}: LifecycleDependencies): void {
  test("first-Agent preserves live and abandoned locks until inspected recovery", async (t) => {
    let agentReads = 0;
    let holdOwner = true;
    const entered = Promise.withResolvers<void>();
    const { directory, engineLog, env } = await k3dFixture(t, "none", (request, response) => {
      if (request.url === "/namespaces/ns_test/agents") {
        agentReads++;
        if (holdOwner) {
          entered.resolve();
          return;
        }
      }
      const responses: Record<string, unknown> = {
        "/installation": { id: "ins_test" },
        "/namespaces": [{ id: "ns_test", name: "default" }],
        "/namespaces/ns_test": { id: "ns_test", status: "ready" },
        "/namespaces/ns_test/agents": [],
      };
      const data = responses[request.url ?? ""];
      response.writeHead(data === undefined ? 404 : 200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(data === undefined ? { error: { code: "NOT_FOUND" } } : { data }),
      );
    });
    for (const name of [
      "CODEX_ACCESS_TOKEN",
      "CODEX_ACCESS_TOKEN_FILE",
      "OPENAI_API_KEY",
      "OPENAI_API_KEY_FILE",
    ]) {
      delete env[name];
    }
    const recordPath = join(
      directory,
      `first-agent-${createHash("sha256").update("state-contract-test").digest("hex").slice(0, 32)}.json`,
    );
    const lockPath = `${recordPath}.lock`;
    // Hold a real CLI invocation after it has acquired its lock and saved its record.
    const owner = spawn(process.execPath, [firstAgent, "state-contract-test"], {
      cwd: repository,
      env,
      stdio: "ignore",
      timeout: 10_000,
    });
    const ownerClosed = once(owner, "close");
    t.after(async () => {
      owner.kill("SIGKILL");
      await ownerClosed;
    });
    await Promise.race([
      entered.promise,
      ownerClosed.then(() => {
        throw new Error("Lock owner exited before its first Agent read");
      }),
    ]);
    const snapshotLock = async () => {
      const file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        const named = await lstat(lockPath);
        assert.equal(named.isFile(), true);
        assert.equal(named.dev, opened.dev);
        assert.equal(named.ino, opened.ino);
        return { dev: opened.dev, ino: opened.ino, pid: await file.readFile("utf8") };
      } finally {
        await file.close();
      }
    };
    const lock = await snapshotLock();
    const record = await readFile(recordPath, "utf8");
    assert.equal(lock.pid, String(owner.pid));
    const assertUnchanged = async () => {
      assert.deepEqual(await snapshotLock(), lock);
      assert.equal(await readFile(recordPath, "utf8"), record);
    };
    const contender = await runFirstAgentAsync(env);
    assert.match(contender, /lock exists|already using this Agent name/);
    assert.equal(agentReads, 1);
    await assertUnchanged();

    // A killed owner leaves a genuine abandoned lock. Concurrent retries must not
    // guess ownership from its dead PID and unlink a successor's directory entry.
    owner.kill("SIGKILL");
    await ownerClosed;
    holdOwner = false;
    const retries = await Promise.all([runFirstAgentAsync(env), runFirstAgentAsync(env)]);
    assert.equal(agentReads, 1, "abandoned-lock retries must not enter the record workflow");
    for (const output of retries) {
      assert.match(output, /lock exists/);
      assert.ok(output.includes(lockPath));
    }
    await assertUnchanged();
    await assert.rejects(readFile(engineLog), { code: "ENOENT" });

    // All children are reaped before the operator removes only the inspected lock.
    // The preserved record is reused, and an ordinary action error releases the new lock.
    await unlink(lockPath);
    const resumed = await runFirstAgentAsync(env);
    assert.match(resumed, /kubectl did not complete successfully \(exit 23\)/);
    assert.equal(agentReads, 2);
    assert.equal(await readFile(recordPath, "utf8"), record);
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  });

  test("first-Agent refuses a lock symlink without following or removing it", async (t) => {
    const { directory, engineLog, env } = await k3dFixture(t);
    const target = join(directory, "lock-target");
    const lockPath = join(
      directory,
      `first-agent-${createHash("sha256").update("state-contract-test").digest("hex").slice(0, 32)}.json.lock`,
    );
    await writeFile(target, "untouched lock target", { mode: 0o600 });
    await symlink(target, lockPath);
    const output = await runFirstAgentAsync(env);
    assert.match(output, /lock exists|must be private and owned/);
    assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), "untouched lock target");
    await assert.rejects(readFile(engineLog), { code: "ENOENT" });
  });

  test(
    "first-Agent keeps its saved record readable after a restrictive-umask attempt",
    { skip: process.platform === "win32" ? "Unix file modes are required" : false },
    async (t) => {
      const { directory, engineLog, env } = await k3dFixture(t);
      // Existing Local Setup files retain their original permissions. Only the new
      // helper process inherits the real kernel umask; no model credential is used.
      await writeFile(engineLog, "", { mode: 0o600 });
      for (const key of [
        "CODEX_ACCESS_TOKEN",
        "CODEX_ACCESS_TOKEN_FILE",
        "OPENAI_API_KEY",
        "OPENAI_API_KEY_FILE",
      ]) {
        delete env[key];
      }
      const strict = {
        ...env,
        NODE_OPTIONS:
          `${env.NODE_OPTIONS ?? ""} --import=data:text/javascript,process.umask(0o777)`.trim(),
      };
      const first = await runFirstAgentAsync(strict);
      assert.match(first, /kubectl did not complete successfully \(exit 23\)/);
      const path = join(
        directory,
        `first-agent-${createHash("sha256").update("state-contract-test").digest("hex").slice(0, 32)}.json`,
      );
      const readRecord = async () => {
        const file = await open(path, "r");
        try {
          return { mode: (await file.stat()).mode & 0o777, content: await file.readFile("utf8") };
        } finally {
          await file.close();
        }
      };
      const saved = await readRecord();
      assert.equal(saved.mode, 0o600);
      await writeFile(engineLog, "", { mode: 0o600 });
      const retry = await runFirstAgentAsync(env);
      assert.match(retry, /kubectl did not complete successfully \(exit 23\)/);
      assert.match(await readFile(engineLog, "utf8"), /exec -i statefulset\/postgres/);
      assert.deepEqual(await readRecord(), saved);
    },
  );

  test("first-Agent refuses an unrecognized saved record without calling it old", async (t) => {
    const { directory, engineLog, env } = await k3dFixture(t);
    const recordPath = join(
      directory,
      `first-agent-${createHash("sha256").update("state-contract-test").digest("hex").slice(0, 32)}.json`,
    );
    const current = {
      version: 3,
      authMethod: "api_key",
      name: "state-contract-test",
      namespaceId: "ns_test",
      model: "gpt-test",
      harness: "openclaw",
      sandboxDriver: "none",
      controlUi: false,
      secretName: "first-agent-test",
    };
    const run = async (record: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}) => {
      await rm(engineLog, { force: true });
      await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return runFirstAgentAsync({ ...env, ...extraEnv });
    };

    // The current record shape passes the check and reaches the database step.
    assert.match(await run(current), /kubectl did not complete successfully \(exit 23\)/);

    // Versions 1 and 2, version 3 without authMethod, a string version, and a
    // newer numeric version cannot be verified. The refusal does not call the
    // record old or tell the operator that a new name recovers it (issue 3362).
    const beforePat: Partial<typeof current> = { ...current };
    delete beforePat.authMethod;
    for (const [label, record, extraEnv] of [
      ["version 1", { ...current, version: 1 }],
      ["version 2", { ...current, version: 2 }],
      ["version 3 without authMethod", beforePat],
      ["version 3 only", { version: 3 }],
      ["string version", { ...current, version: "3" }],
      ["version 4", { ...current, version: 4 }],
      [
        "version 1 with a selected model",
        { ...current, version: 1 },
        { OPENCLAW_FIRST_AGENT_MODEL: "gpt-other" },
      ],
    ] satisfies Array<[string, Record<string, unknown>, NodeJS.ProcessEnv?]>) {
      const saved = `${JSON.stringify(record)}\n`;
      const output = await run(record, extraEnv);
      assert.match(output, /saved record this helper does not recognize/, label);
      assert.match(output, /Choosing a new Agent name starts a different Agent/, label);
      assert.doesNotMatch(output, /older first-agent helper/, label);
      assert.doesNotMatch(output, /differs|Personal access tokens/, label);
      assert.equal(await readFile(recordPath, "utf8"), saved, label);
      await assert.rejects(readFile(engineLog), { code: "ENOENT" }, label);
    }

    // A changed selection on a current record keeps its own refusal.
    assert.match(
      await run({ ...current, harness: "codex" }),
      /recorded Namespace, model, Harness, Sandbox Driver, or Control UI selection differs/,
    );
  });
}
