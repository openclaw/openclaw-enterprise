import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { bindRole, grantRole } from "../helpers/iam-grants.mjs";

const run = promisify(execFile);
const occCli = join(process.cwd(), "bin", "occ");

// Real Fastify HTTP, Better Auth plugin/storage, OCC, and native IAM. This test
// does not claim PostgreSQL or Agent runtime coverage.
test("service API keys authenticate scoped automation without replacing sessions or IAM", async (t) => {
  // Build the real CLI once, then exercise it through a live Fastify socket below.
  await run("go", ["build", "-trimpath", "-o", occCli, "./cmd/occ"]);
  const installationId = `ins_${randomUUID()}`;
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const authOptions = {
    installationId,
    mode: "development",
    baseURL: "http://127.0.0.1",
    secret: `test-secret-${randomUUID()}`,
    memoryDatabase,
    secureCookies: false,
  };
  const auth = createControllerAuth(authOptions);
  const credentials = { email: "admin@example.invalid", password: `test-password-${randomUUID()}` };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account, { grant: "administrator" });
  const policy = {
    identities: [seed.principal],
    roles: [...seed.roles],
    bindings: [...seed.bindings],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const auditSink = new InMemoryAuditSink();
  const runtimeCredentialStatus = new Map();
  const computeDriver = {
    ...createDevelopmentComputeDriver(),
    async getAgentRuntimeCredentialStatus({ namespace, agent }) {
      return (
        runtimeCredentialStatus.get(`${namespace.id}:${agent.id}`) ?? {
          transportConfigured: false,
        }
      );
    },
    async provisionAgentRuntimeCredentials({ namespace, agent }) {
      const status = { transportConfigured: true };
      runtimeCredentialStatus.set(`${namespace.id}:${agent.id}`, status);
      return status;
    },
  };
  let controller;
  const app = createFastifyApp({
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId },
    computeDriver,
    secretDriver: createTestSecretDriver(),
    configurationDriver: createTestConfigurationDriver(),
    resolveHarness: resolveApprovedDevelopmentHarness,
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = await signInWithEmailPassword({ origin, ...credentials });
  async function request(
    method,
    path,
    { headers = { cookie: session.cookie, origin: authOptions.baseURL }, body } = {},
  ) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, ...(await response.json()) };
  }
  assert.equal(
    (await request("POST", "/installation/bootstrap", { body: { name: "Service keys test" } }))
      .status,
    201,
  );
  const tenantA = await request("POST", "/namespaces", { body: { name: "tenant-a" } });
  const tenantB = await request("POST", "/namespaces", { body: { name: "tenant-b" } });
  assert.equal(tenantA.status, 201);
  assert.equal(tenantB.status, 201);
  const namespaceId = tenantA.data.id;
  const path = `/namespaces/${namespaceId}`;
  const principal = { kind: "service_principal", id: `sp_${randomUUID()}`, namespaceId };
  policy.identities.push(principal);
  grantRole(policy, principal.id, {
    id: "tenant-automation",
    bindingId: "service-automation",
    namespaceId,
    permissions: {
      namespace: ["read"],
      configuration: ["create", "delete"],
      secret: ["create", "read", "update", "delete"],
      preset: ["read"],
      agent: ["read", "operate", "delete"],
    },
  });
  const body = { servicePrincipalId: principal.id, namespaceId, name: "tenant-automation" };
  const issue = () => request("POST", "/api/auth/service-keys", { body });
  async function assertServiceKeyManagementDenied(headers, keyResponse, status) {
    assert.equal(
      (await request("POST", "/api/auth/service-keys", { headers, body })).status,
      status,
    );
    assert.equal(
      (await request("DELETE", `/api/auth/service-keys/${keyResponse.data.id}`, { headers }))
        .status,
      status,
    );
  }
  // A key's expiry is computed from the controller's clock at issuance; allow one second
  // of rounding on either side of the request.
  function assertIssuedLifetime(response, before, seconds) {
    const expiresAt = Date.parse(response.data.expiresAt);
    assert.ok(
      expiresAt >= before + seconds * 1000 - 1000 &&
        expiresAt <= Date.now() + seconds * 1000 + 1000,
      `expiresAt ${response.data.expiresAt} is not ${seconds} s after issuance`,
    );
  }
  const issuedBefore = Date.now();
  const issued = await issue();
  assert.equal(issued.status, 201);
  // Without expiresIn a key lives the documented 30 days.
  assertIssuedLifetime(issued, issuedBefore, 30 * 24 * 60 * 60);
  assert.equal(issued.data.servicePrincipalId, principal.id);
  assert.equal(issued.data.namespaceId, namespaceId);
  assert.match(issued.data.key, /^occ_/);
  const headers = { "x-api-key": issued.data.key };

  await t.test(
    "valid key reads the exact Namespace and never creates a user or session",
    async () => {
      assert.equal((await request("GET", path, { headers })).status, 200);
      assert.equal(memoryDatabase.user.length, 1);
      assert.equal(memoryDatabase.session.length, 1);
      const inspected = await request("GET", "/api/auth/session", { headers });
      assert.equal(inspected.data, null);
      assert.equal((await request("GET", "/installation")).status, 200);
    },
  );

  await t.test(
    "audit rows name the service key that acted, apart from its principal's other keys",
    async () => {
      const second = await issue();
      assert.equal(second.status, 201);
      const configurationIds = [];
      for (const key of [issued.data, second.data]) {
        const created = await request("POST", `/namespaces/${namespaceId}/configurations`, {
          headers: { "x-api-key": key.key },
          body: { kind: "agent", values: { model: "gpt-test" } },
        });
        assert.equal(created.status, 201);
        configurationIds.push(created.data.id);
        const mutation = auditSink.events.find(
          (event) =>
            event.action === "openclaw.configurations.create" &&
            event.resource.id === created.data.id,
        );
        assert.equal(mutation.actorId, principal.id);
        assert.equal(mutation.details?.actorServiceKeyId, key.id);
      }
      // A denial names the key too; the key's Role reads Presets but cannot create them.
      const deniedBefore = auditSink.events.length;
      assert.equal(
        (
          await request("POST", `/namespaces/${namespaceId}/presets`, {
            headers: { "x-api-key": second.data.key },
            body: { name: "denied-preset", template: { agent: { name: "Denied" } } },
          })
        ).status,
        403,
      );
      const denial = auditSink.events
        .slice(deniedBefore)
        .find((event) => event.kind === "authorization_denial");
      assert.equal(denial.actorId, principal.id);
      assert.equal(denial.details?.actorServiceKeyId, second.data.id);
      // The acting key joins the denial's IAM evidence; it does not replace it.
      assert.equal(denial.details.iamEvidence.identityId, principal.id);
      // Session requests carry no key; key management names the key acted on and its name.
      for (const id of configurationIds) {
        const deleted = await fetch(`${origin}/namespaces/${namespaceId}/configurations/${id}`, {
          method: "DELETE",
          headers: { cookie: session.cookie, origin: authOptions.baseURL },
        });
        assert.equal(deleted.status, 204);
      }
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${second.data.id}`)).status,
        200,
      );
      for (const action of ["create", "revoke"]) {
        const managed = auditSink.events.find(
          (event) =>
            event.action === `openclaw.auth.service-keys.${action}` &&
            event.details.serviceKeyId === second.data.id,
        );
        assert.equal(managed.actorId, seed.principal.id);
        assert.equal(managed.details.serviceKeyName, "tenant-automation");
        assert.equal(Object.hasOwn(managed.details, "actorServiceKeyId"), false);
      }
      const sessionDeletes = auditSink.events.filter(
        (event) =>
          event.action === "openclaw.configurations.delete" &&
          configurationIds.includes(event.resource.id),
      );
      assert.equal(sessionDeletes.length, 2);
      for (const event of sessionDeletes) {
        assert.equal(event.details?.actorServiceKeyId, undefined);
      }
      const recorded = JSON.stringify(auditSink.events);
      assert.equal(recorded.includes(issued.data.key), false);
      assert.equal(recorded.includes(second.data.key), false);
    },
  );

  await t.test("occ CLI exercises Configuration CRUD and Agent stop/delete", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-occ-cli-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const keyFile = join(directory, "service-key.json");
    const adminKeyFile = join(directory, "admin-service-key.json");
    const bodyFile = join(directory, "configuration.json");
    const ambiguousBodyFile = join(directory, "ambiguous-configuration.json");
    const secretFile = join(directory, "secret.json");
    const secretUpdateFile = join(directory, "secret-update.json");
    const roleFile = join(directory, "role.json");
    await writeFile(keyFile, JSON.stringify(issued), { mode: 0o600 });
    await writeFile(bodyFile, JSON.stringify({ kind: "agent", values: { model: "gpt-test" } }), {
      mode: 0o600,
    });
    await writeFile(secretFile, JSON.stringify({ name: "cli-secret", value: "initial-secret" }), {
      mode: 0o600,
    });
    await writeFile(secretUpdateFile, JSON.stringify({ value: "rotated-secret" }), {
      mode: 0o600,
    });
    await writeFile(
      roleFile,
      JSON.stringify({
        name: "CLI secret operator",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      ambiguousBodyFile,
      '{"kind":"agent","kind":"agent","values":{"model":"gpt-test"}}',
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      OCC_URL: origin,
      OCC_SERVICE_KEY_FILE: keyFile,
      OCC_NAMESPACE: namespaceId,
    };
    // IAM policy management requires Installation administer. Grant only that,
    // not the bootstrap administrator Role, so the key cannot reach other data.
    const installationPrincipal = { kind: "service_principal", id: `sp_${randomUUID()}` };
    policy.identities.push(installationPrincipal);
    grantRole(policy, installationPrincipal.id, {
      id: "cli-installation-iam-administrator",
      permissions: { installation: ["administer"] },
      resource: { kind: "installation", id: installationId },
    });
    grantRole(policy, installationPrincipal.id, {
      id: "cli-installation-namespace-reader",
      namespaceId,
      permissions: { namespace: ["read"] },
      resource: { kind: "namespace", id: namespaceId },
    });
    const adminKey = await request("POST", "/api/auth/service-keys", {
      body: { servicePrincipalId: installationPrincipal.id, name: "cli-installation-admin" },
    });
    assert.equal(adminKey.status, 201);
    await writeFile(adminKeyFile, JSON.stringify(adminKey), { mode: 0o600 });
    const adminEnv = { ...env, OCC_SERVICE_KEY_FILE: adminKeyFile };

    // Reject ambiguous object members before a credentialed mutation can reach OCC.
    await assert.rejects(
      run(occCli, ["configuration", "create", "--file", ambiguousBodyFile], { env }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /invalid JSON file/);
        return true;
      },
    );

    // Exercise a domain command and JSON file input against a real write route.
    const created = await run(
      occCli,
      ["configuration", "create", "--file", bodyFile, "--output", "json"],
      { env },
    );
    const configuration = JSON.parse(created.stdout);
    const configurationPath = `/namespaces/${namespaceId}/configurations/${configuration.id}`;
    assert.equal(configuration.values.model, "gpt-test");

    // A bodyless 204 becomes a stable domain result instead of leaking transport details.
    const deleted = await run(
      occCli,
      ["configuration", "delete", configuration.id, "--output", "json"],
      { env },
    );
    assert.deepEqual(JSON.parse(deleted.stdout), {
      deleted: true,
      id: configuration.id,
      kind: "configuration",
    });
    assert.equal((await request("GET", configurationPath)).status, 404);

    // Secret material and Agent runtime operations require a ready Namespace.
    const readyNamespace = await controller.handleNamespaceLifecycle(
      seed.principal.id,
      namespaceId,
      "ready",
    );
    assert.equal(readyNamespace.status, "ready");
    const secretCreated = await run(
      occCli,
      ["secret", "create", "--file", secretFile, "--output", "json"],
      { env },
    );
    const cliSecret = JSON.parse(secretCreated.stdout);
    assert.equal(cliSecret.name, "cli-secret");
    assert.equal(Object.hasOwn(cliSecret, "value"), false);
    const secretRead = await run(occCli, ["secret", "get", cliSecret.id, "--output", "json"], {
      env,
    });
    assert.equal(JSON.parse(secretRead.stdout).id, cliSecret.id);
    const secretUpdated = await run(
      occCli,
      ["secret", "update", cliSecret.id, "--file", secretUpdateFile, "--output", "json"],
      { env },
    );
    assert.deepEqual(JSON.parse(secretUpdated.stdout), cliSecret);

    // Presets: the key may read them but not delete them until it is granted delete.
    const preset = await request("POST", `/namespaces/${namespaceId}/presets`, {
      body: { name: "cli-preset", template: { agent: { name: "CLI Preset Agent" } } },
    });
    assert.equal(preset.status, 201);
    const presetList = await run(occCli, ["preset", "list", "-o", "json"], { env });
    assert.deepEqual(
      JSON.parse(presetList.stdout).map(({ id, name }) => ({ id, name })),
      [{ id: preset.data.id, name: "cli-preset" }],
    );
    const presetRead = await run(occCli, ["preset", "get", preset.data.id, "-o", "json"], {
      env,
    });
    assert.deepEqual(JSON.parse(presetRead.stdout), preset.data);
    await assert.rejects(run(occCli, ["preset", "delete", preset.data.id], { env }), (error) => {
      assert.match(error.stderr, /HTTP 403\)/);
      return true;
    });
    assert.equal(
      (await request("GET", `/namespaces/${namespaceId}/presets/${preset.data.id}`)).status,
      200,
    );
    // The grant stays on the key's Role for the rest of this test.
    policy.roles
      .find((candidate) => candidate.id === "tenant-automation")
      .permissions.push({ action: "delete", resourceKind: "preset" });
    const presetDeleted = await run(
      occCli,
      ["preset", "delete", preset.data.id, "--output", "json"],
      { env },
    );
    assert.deepEqual(JSON.parse(presetDeleted.stdout), {
      deleted: true,
      id: preset.data.id,
      kind: "preset",
    });
    assert.equal(
      (await request("GET", `/namespaces/${namespaceId}/presets/${preset.data.id}`)).status,
      404,
    );

    // Seed the server-owned resource through the administrator session so the
    // scoped CLI credential exercises only its granted Agent operations.
    const agentConfiguration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: { kind: "agent", values: {} },
    });
    assert.equal(agentConfiguration.status, 201);
    const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
      body: { name: "cli-stop-agent", configurationId: agentConfiguration.data.id },
    });
    assert.equal(agent.status, 201);
    const source = await controller.createSecret(seed.principal.id, {
      namespaceId,
      name: "cli-model-key",
      value: "synthetic-cli-model-key",
    });
    const boundAgent = await controller.updateAgent(seed.principal.id, {
      namespaceId,
      agentId: agent.data.id,
      configurationId: agentConfiguration.data.id,
      harnessAuth: { method: "api_key", source: source.ref },
    });
    policy.identities.push({
      kind: "service_principal",
      id: boundAgent.servicePrincipalId,
      namespaceId,
      agentId: boundAgent.id,
    });
    policy.roles.push({
      id: "cli-model-consumer",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    bindRole(policy, boundAgent.servicePrincipalId, {
      id: "cli-model-consumer",
      roleId: "cli-model-consumer",
      namespaceId,
      resource: { kind: "secret", id: source.id },
    });
    const roleCreated = await run(
      occCli,
      ["iam", "role", "create", "--file", roleFile, "-o", "json"],
      {
        env: adminEnv,
      },
    );
    const role = JSON.parse(roleCreated.stdout);
    assert.equal(role.name, "CLI secret operator");
    assert.deepEqual(role.permissions, [{ action: "operate", resourceKind: "secret" }]);
    const roleList = await run(occCli, ["iam", "role", "list", "-o", "json"], {
      env: adminEnv,
    });
    assert.ok(JSON.parse(roleList.stdout).some((candidate) => candidate.id === role.id));
    const roleRead = await run(occCli, ["iam", "role", "get", role.id, "-o", "json"], {
      env: adminEnv,
    });
    assert.deepEqual(JSON.parse(roleRead.stdout), role);
    grantRole(policy, installationPrincipal.id, {
      id: "cli-installation-secret-reader",
      namespaceId,
      permissions: { secret: ["read"] },
      resource: { kind: "secret", id: cliSecret.id },
    });
    const bindingFile = join(directory, "binding.json");
    await writeFile(
      bindingFile,
      JSON.stringify({
        subjectKind: "identity",
        subjectId: boundAgent.servicePrincipalId,
        roleId: role.id,
        resourceKind: "secret",
        resourceId: cliSecret.id,
      }),
      { mode: 0o600 },
    );
    const bindingCreated = await run(
      occCli,
      ["iam", "access-binding", "create", "--file", bindingFile, "-o", "json"],
      { env: adminEnv },
    );
    const binding = JSON.parse(bindingCreated.stdout);
    assert.equal(binding.subjectId, boundAgent.servicePrincipalId);
    assert.equal(binding.roleId, role.id);
    assert.equal(binding.resourceId, cliSecret.id);
    const bindingList = await run(occCli, ["iam", "access-binding", "list", "-o", "json"], {
      env: adminEnv,
    });
    assert.ok(JSON.parse(bindingList.stdout).some((candidate) => candidate.id === binding.id));
    const bindingRead = await run(
      occCli,
      ["iam", "access-binding", "get", binding.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(JSON.parse(bindingRead.stdout), binding);

    // An Installation administrator creates a Namespace ServicePrincipal for a member's CLI.
    // It holds no grant until an AccessBinding names it (proved with PostgreSQL policy in
    // postgres-service-api-keys.test.mjs).
    const principalCreated = await run(
      occCli,
      ["iam", "service-principal", "create", "-o", "json"],
      { env: adminEnv },
    );
    const createdPrincipal = JSON.parse(principalCreated.stdout);
    assert.match(createdPrincipal.id, /^spn_/);
    assert.equal(createdPrincipal.namespaceId, namespaceId);
    const principalList = await run(occCli, ["iam", "service-principal", "list", "-o", "json"], {
      env: adminEnv,
    });
    assert.deepEqual(JSON.parse(principalList.stdout), [createdPrincipal]);
    const principalRead = await run(
      occCli,
      ["iam", "service-principal", "get", createdPrincipal.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(JSON.parse(principalRead.stdout), createdPrincipal);

    // occ service-key create writes a private key file that occ itself accepts, and never
    // prints the key. The administrator key covers its own grants, so it may rotate itself.
    const rotatedKeyFile = join(directory, "rotated-admin-key.json");
    const { OCC_NAMESPACE: _namespace, ...installationEnv } = adminEnv;
    const rotated = await run(
      occCli,
      [
        "service-key",
        "create",
        "--service-principal",
        installationPrincipal.id,
        "--name",
        "cli-rotated",
        "--expires-in-days",
        "2",
        "--out",
        rotatedKeyFile,
        "-o",
        "json",
      ],
      { env: installationEnv },
    );
    const rotatedDetails = JSON.parse(rotated.stdout);
    assert.equal(rotatedDetails.servicePrincipalId, installationPrincipal.id);
    assert.equal(rotatedDetails.key, undefined);
    // Read mode and content through one handle so both describe the same file.
    const rotatedHandle = await open(rotatedKeyFile);
    let rotatedKey;
    try {
      assert.equal((await rotatedHandle.stat()).mode & 0o777, 0o600);
      rotatedKey = JSON.parse(await rotatedHandle.readFile("utf8")).data;
    } finally {
      await rotatedHandle.close();
    }
    assert.equal(rotatedKey.id, rotatedDetails.id);
    assert.ok(!rotated.stdout.includes(rotatedKey.key));
    const rotatedEnv = { ...adminEnv, OCC_SERVICE_KEY_FILE: rotatedKeyFile };
    await run(occCli, ["iam", "service-principal", "list"], { env: rotatedEnv });
    // An existing file is never overwritten, and no key is issued for it.
    const keysBeforeClobber = memoryDatabase.apikey.length;
    await assert.rejects(
      run(
        occCli,
        [
          "service-key",
          "create",
          "--service-principal",
          installationPrincipal.id,
          "--name",
          "cli-clobber",
          "--out",
          rotatedKeyFile,
        ],
        { env: installationEnv },
      ),
      /failed to create key file/,
    );
    assert.equal(memoryDatabase.apikey.length, keysBeforeClobber);
    // An explicit zero is invalid, not the API's omitted 30-day default.
    const zeroExpiryFile = join(directory, "zero-expiry-key.json");
    await assert.rejects(
      run(
        occCli,
        [
          "service-key",
          "create",
          "--service-principal",
          installationPrincipal.id,
          "--name",
          "zero-expiry",
          "--out",
          zeroExpiryFile,
          "--expires-in-days=0",
        ],
        { env: installationEnv },
      ),
      { stderr: /between 1 and 365/ },
    );
    await assert.rejects(open(zeroExpiryFile), { code: "ENOENT" });
    assert.equal(memoryDatabase.apikey.length, keysBeforeClobber);
    for (const days of [1, 365]) {
      const before = Date.now();
      const created = JSON.parse(
        (
          await run(
            occCli,
            [
              "service-key",
              "create",
              "--service-principal",
              installationPrincipal.id,
              "--name",
              `expiry-${days}`,
              "--out",
              join(directory, `expiry-${days}.json`),
              `--expires-in-days=${days}`,
              "-o",
              "json",
            ],
            { env: installationEnv },
          )
        ).stdout,
      );
      assert.ok(Math.abs(Date.parse(created.expiresAt) - before - days * 86_400_000) < 10_000);
      await run(occCli, ["service-key", "revoke", created.id], { env: adminEnv });
    }
    assert.equal(memoryDatabase.apikey.length, keysBeforeClobber);
    // The CLI counts the name as the API does: 32 emoji are issued, 33 never leave the CLI.
    const emojiKeyFile = join(directory, "emoji-key.json");
    const emojiCreate = (name, out) =>
      run(
        occCli,
        [
          "service-key",
          "create",
          "--service-principal",
          installationPrincipal.id,
          "--name",
          name,
          "--out",
          out,
          "-o",
          "json",
        ],
        { env: installationEnv },
      );
    const emoji = JSON.parse((await emojiCreate("😀".repeat(32), emojiKeyFile)).stdout);
    assert.equal(emoji.name, "😀".repeat(32));
    await assert.rejects(emojiCreate("😀".repeat(33), join(directory, "emoji-33.json")), {
      stderr: /1 to 32 characters/,
    });
    assert.equal(memoryDatabase.apikey.length, keysBeforeClobber + 1);
    await run(occCli, ["service-key", "revoke", emoji.id], { env: adminEnv });
    const revokedRotated = await run(
      occCli,
      ["service-key", "revoke", rotatedDetails.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(JSON.parse(revokedRotated.stdout), { id: rotatedDetails.id, revoked: true });
    await assert.rejects(run(occCli, ["iam", "service-principal", "list"], { env: rotatedEnv }), {
      stderr: /HTTP 401/,
    });
    // A secret Role bound to the Namespace could never grant anything there: the CLI shows
    // the API's refusal naming the Permissions instead of reporting a created binding.
    const inapplicableFile = join(directory, "inapplicable-binding.json");
    await writeFile(
      inapplicableFile,
      JSON.stringify({
        subjectKind: "identity",
        subjectId: boundAgent.servicePrincipalId,
        roleId: role.id,
        resourceKind: "namespace",
        resourceId: namespaceId,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      run(occCli, ["iam", "access-binding", "create", "--file", inapplicableFile], {
        env: adminEnv,
      }),
      (error) => {
        assert.match(
          error.stderr,
          /HTTP 400\): INVALID_REQUEST: Role \S+ grants nothing on the namespace target: its Permissions \(secret:operate\)/,
        );
        return true;
      },
    );

    // This Installation selects no Credential Gateway: the CLI names it and the reference
    // instead of an opaque dependency failure.
    grantRole(policy, principal.id, {
      id: "cli-credential-source-creator",
      namespaceId,
      permissions: { credential_source: ["create"] },
    });
    const sourceFile = join(directory, "credential-source.json");
    await writeFile(sourceFile, JSON.stringify({ name: "openai-key", type: "openai" }), {
      mode: 0o600,
    });
    await assert.rejects(
      run(occCli, ["credential-source", "create", "--file", sourceFile], { env }),
      (error) => {
        assert.match(
          error.stderr,
          /HTTP 409\): CREDENTIAL_GATEWAY_NOT_CONFIGURED: This Installation has no Credential Gateway.*docs-enterprise\.openclaw\.org\/reference\/credential-sources\//,
        );
        return true;
      },
    );
    const runtimeInitial = await run(
      occCli,
      ["agent", "runtime-credentials", "get", agent.data.id, "-o", "json"],
      { env },
    );
    assert.deepEqual(JSON.parse(runtimeInitial.stdout), { transportConfigured: false });
    const runtimeProvisioned = await run(
      occCli,
      ["agent", "runtime-credentials", "provision", agent.data.id, "-o", "json"],
      { env },
    );
    const runtimeMetadata = JSON.parse(runtimeProvisioned.stdout);
    assert.equal(runtimeMetadata.transportConfigured, true);
    const deployed = await request(
      "POST",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
    );
    assert.equal(deployed.status, 202);
    assert.equal(
      (await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`)).data
        .desiredRuntimeState,
      "running",
    );

    const stopped = await run(occCli, ["agent", "stop", agent.data.id], { env });
    assert.match(stopped.stdout, /DESIRED STATE/);
    assert.match(stopped.stdout, new RegExp(`${agent.data.id}.*stopped`));
    const current = await run(occCli, ["agent", "get", agent.data.id, "--output", "json"], {
      env,
    });
    const currentAgent = JSON.parse(current.stdout);
    assert.deepEqual(
      {
        id: currentAgent.id,
        desiredRuntimeState: currentAgent.desiredRuntimeState,
      },
      { id: agent.data.id, desiredRuntimeState: "stopped" },
    );
    const bindingDeleted = await run(
      occCli,
      ["iam", "access-binding", "delete", binding.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(JSON.parse(bindingDeleted.stdout), {
      deleted: true,
      id: binding.id,
      kind: "iam access-binding",
    });
    const roleDeleted = await run(occCli, ["iam", "role", "delete", role.id, "-o", "json"], {
      env: adminEnv,
    });
    assert.deepEqual(JSON.parse(roleDeleted.stdout), {
      deleted: true,
      id: role.id,
      kind: "iam role",
    });
    const secretDeleted = await run(occCli, ["secret", "delete", cliSecret.id, "-o", "json"], {
      env,
    });
    assert.deepEqual(JSON.parse(secretDeleted.stdout), {
      deleted: true,
      id: cliSecret.id,
      kind: "secret",
    });
    assert.equal(
      (await request("GET", `/namespaces/${namespaceId}/secrets/${cliSecret.id}`)).status,
      404,
    );

    const deleting = await run(occCli, ["agent", "delete", agent.data.id], { env });
    assert.match(deleting.stdout, /LIFECYCLE/);
    assert.match(deleting.stdout, new RegExp(`${agent.data.id}.*deleting`));
    const deletingAgent = await run(occCli, ["agent", "get", agent.data.id, "--output", "json"], {
      env,
    });
    assert.equal(JSON.parse(deletingAgent.stdout).status, "deleting");

    await assert.rejects(
      run(occCli, ["installation", "get", "--output", "json"], { env }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /FORBIDDEN/);
        assert.match(error.stderr, /HTTP 403/);
        return true;
      },
    );
  });

  await t.test(
    "invalid credentials fail closed even alongside a valid administrator cookie",
    async () => {
      for (const key of ["", "forged-key", `${issued.data.key}tampered`]) {
        const invalidHeaders = { "x-api-key": key, cookie: session.cookie };
        assert.equal((await request("GET", path, { headers: invalidHeaders })).status, 401);
        await assertServiceKeyManagementDenied(invalidHeaders, issued, 401);
      }
      assert.equal((await request("GET", path, { headers: {} })).status, 401);
      assert.equal(
        (await request("GET", path, { headers: { authorization: `Bearer ${issued.data.key}` } }))
          .status,
        401,
      );
    },
  );

  await t.test("Namespace boundaries and exact IAM permissions remain authoritative", async () => {
    // The key's fixed Namespace refuses every other route before IAM is asked, and the
    // refusal is audited against the key's service principal.
    for (const other of [`/namespaces/${tenantB.data.id}`, "/installation"]) {
      const eventsBefore = auditSink.events.length;
      const denied = await request("GET", other, { headers });
      assert.equal(denied.status, 403);
      assert.equal(denied.error.message, "The admitted Namespace does not match.");
      assert.equal(auditSink.events.length, eventsBefore + 1);
      const audit = auditSink.events.at(-1);
      assert.equal(audit.kind, "authorization_denial");
      assert.equal(audit.actorId, principal.id);
    }
    assert.equal((await request("DELETE", path, { headers })).status, 403);
    // Removing a grant is immediately visible without reissuing the credential.
    const bindingIndex = policy.bindings.findIndex((entry) => entry.id === "service-automation");
    const [binding] = policy.bindings.splice(bindingIndex, 1);
    assert.equal((await request("GET", path, { headers })).status, 403);
    policy.bindings.push(binding);
    policy.restrictions.push({
      id: "deny-read",
      namespaceId,
      resourceKind: "namespace",
      action: "read",
      effect: "deny",
    });
    assert.equal((await request("GET", path, { headers })).status, 403);
    policy.restrictions.length = 0;
    assert.equal((await request("GET", path, { headers })).status, 200);
    // Even an administrative Role cannot widen a credential's fixed Namespace.
    bindRole(policy, principal.id, {
      id: "namespace-service-admin",
      roleId: seed.bindings[0].roleId,
      namespaceId,
    });
    await assertServiceKeyManagementDenied(headers, issued, 403);
    policy.bindings.pop();
  });

  await t.test("service credentials cannot manage human accounts or bootstrap", async () => {
    assert.equal((await request("POST", "/api/auth/accounts", { headers, body: {} })).status, 401);
    assert.equal(
      (await request("POST", "/installation/bootstrap", { headers, body: {} })).status,
      401,
    );
    assert.equal((await request("POST", "/api/auth/api-key/create", { body })).status, 404);
    assert.equal((await request("POST", "/api/auth/api-key/update", { body: {} })).status, 404);
  });

  await t.test(
    "Installation service administrators issue and rotate keys under current IAM policy",
    async () => {
      const installationPrincipal = { kind: "service_principal", id: `sp_${randomUUID()}` };
      policy.identities.push(installationPrincipal);
      grantRole(policy, installationPrincipal.id, {
        id: "installation-reader",
        bindingId: "installation-service-reader",
        permissions: { installation: ["read"] },
      });
      const created = await request("POST", "/api/auth/service-keys", {
        body: { servicePrincipalId: installationPrincipal.id, name: "installation-reader" },
      });
      assert.equal(created.status, 201);
      const keyHeaders = { "x-api-key": created.data.key };
      assert.equal((await request("GET", "/installation", { headers: keyHeaders })).status, 200);
      assert.equal((await request("GET", path, { headers: keyHeaders })).status, 403);
      // A reader key cannot borrow the human cookie's Installation authority.
      const managementHeaders = { ...keyHeaders, cookie: session.cookie };
      await assertServiceKeyManagementDenied(managementHeaders, created, 403);
      // Installation administer alone cannot issue a key that reaches the
      // Namespace grants the issuer itself lacks.
      const exactAdminBinding = {
        id: "installation-service-exact-admin",
        subjectKind: "identity",
        subjectId: installationPrincipal.id,
        roleId: seed.bindings[0].roleId,
        resourceKind: "installation",
        resourceId: installationId,
      };
      policy.bindings.push(exactAdminBinding);
      assert.equal(
        (await request("POST", "/api/auth/service-keys", { headers: keyHeaders, body })).status,
        403,
      );
      policy.bindings.splice(policy.bindings.indexOf(exactAdminBinding), 1);
      const adminBinding = {
        id: "installation-service-admin",
        subjectKind: "identity",
        subjectId: installationPrincipal.id,
        roleId: seed.bindings[0].roleId,
      };
      policy.bindings.push(adminBinding);
      const child = await request("POST", "/api/auth/service-keys", { headers: keyHeaders, body });
      assert.equal(child.status, 201);
      assert.equal(child.data.servicePrincipalId, principal.id);
      assert.equal(
        (await request("GET", path, { headers: { "x-api-key": child.data.key } })).status,
        200,
      );
      // Automated rotation issues a replacement and uses it to revoke the old key.
      const replacement = await request("POST", "/api/auth/service-keys", {
        headers: keyHeaders,
        body: { servicePrincipalId: installationPrincipal.id, name: "replacement-admin" },
      });
      assert.equal(replacement.status, 201);
      const replacementHeaders = { "x-api-key": replacement.data.key };
      assert.equal(
        (
          await request("DELETE", `/api/auth/service-keys/${created.data.id}`, {
            headers: replacementHeaders,
          })
        ).status,
        200,
      );
      await assertServiceKeyManagementDenied(managementHeaders, child, 401);

      // Management rechecks IAM: neither a removed grant nor a deny Restriction
      // can be bypassed by retaining a valid administrator credential.
      policy.bindings.pop();
      for (const restricted of [false, true]) {
        if (restricted) {
          policy.bindings.push(adminBinding);
          policy.restrictions.push({
            id: "deny-service-key-management",
            resourceKind: "installation",
            resourceId: installationId,
            action: "administer",
            effect: "deny",
          });
        }
        await assertServiceKeyManagementDenied(replacementHeaders, child, 403);
      }
      policy.restrictions.pop();
      for (const key of [child.data, replacement.data]) {
        const revoked = await request("DELETE", `/api/auth/service-keys/${key.id}`, {
          headers: replacementHeaders,
        });
        assert.equal(revoked.status, 200);
        assert.equal(revoked.data.revoked, true);
        assert.equal(JSON.stringify(revoked).includes(key.key), false);
        assert.equal(
          (
            await request("GET", key.namespaceId ? path : "/installation", {
              headers: { "x-api-key": key.key },
            })
          ).status,
          401,
        );
      }
      // Audits attribute issuance/revocation to the service actor, not the human
      // who originally issued its key, and never contain credential material.
      // Each also names the key that acted (`actorServiceKeyId`) apart from the key acted on.
      for (const [action, key, actorKey] of [
        ["create", child.data, created.data],
        ["create", replacement.data, created.data],
        ["revoke", created.data, replacement.data],
        ["revoke", child.data, replacement.data],
        ["revoke", replacement.data, replacement.data],
      ]) {
        assert.ok(
          auditSink.events.some(
            (event) =>
              event.action === `openclaw.auth.service-keys.${action}` &&
              event.actorId === installationPrincipal.id &&
              event.details.serviceKeyId === key.id &&
              event.details.serviceKeyName === key.name &&
              event.details.actorServiceKeyId === actorKey.id &&
              event.details.servicePrincipalId === key.servicePrincipalId,
          ),
          `${action} ${key.name}`,
        );
        assert.equal(JSON.stringify(auditSink.events).includes(key.key), false);
      }
      assert.equal(memoryDatabase.user.length, 1);
      assert.equal(memoryDatabase.session.length, 1);
    },
  );

  await t.test(
    "unknown, human, wrong-scope, and Agent-owned subjects cannot receive keys",
    async () => {
      for (const candidate of [
        { ...body, servicePrincipalId: "missing" },
        { ...body, servicePrincipalId: seed.principal.id },
        { ...body, namespaceId: tenantB.data.id },
      ]) {
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { body: candidate })).status,
          400,
        );
      }
      // Creating an Agent through OCC provisions its real dedicated IAM identity.
      // Its workload-credential path must not be replaced by an ordinary service key.
      const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
        body: { kind: "agent", values: {} },
      });
      assert.equal(configuration.status, 201);
      const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
        body: { name: "owned-agent", configurationId: configuration.data.id },
      });
      assert.equal(agent.status, 201);
      const ownedAgent = await controller.getAgent(seed.principal.id, namespaceId, agent.data.id);
      policy.identities.push({
        kind: "service_principal",
        id: ownedAgent.servicePrincipalId,
        agentId: agent.data.id,
        namespaceId,
      });
      assert.equal(
        (
          await request("POST", "/api/auth/service-keys", {
            body: { ...body, servicePrincipalId: ownedAgent.servicePrincipalId },
          })
        ).status,
        400,
      );
      for (const extra of [
        { permissions: { installation: ["administer"] } },
        { userId: account.id },
        { expiresIn: 0 },
        { expiresIn: 31536001 },
      ]) {
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { body: { ...body, ...extra } })).status,
          400,
        );
      }
    },
  );

  await t.test(
    "a signed-in human still needs Installation administer to issue or revoke",
    async () => {
      const adminBinding = policy.bindings.shift();
      assert.equal((await issue()).status, 403);
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${issued.data.id}`)).status,
        403,
      );
      policy.bindings.unshift(adminBinding);
    },
  );

  await t.test("a requested lifetime sets the key's expiry", async () => {
    const before = Date.now();
    const shortLived = await request("POST", "/api/auth/service-keys", {
      body: { ...body, expiresIn: 86400 },
    });
    assert.equal(shortLived.status, 201);
    assertIssuedLifetime(shortLived, before, 86400);
    assert.equal(
      (await request("GET", path, { headers: { "x-api-key": shortLived.data.key } })).status,
      200,
    );
    // Revoking takes no body; one is refused with the same wording as OCC's bodyless
    // operations, and the key stays valid.
    const withBody = await request("DELETE", `/api/auth/service-keys/${shortLived.data.id}`, {
      body: {},
    });
    assert.equal(withBody.status, 400);
    assert.equal(withBody.error.code, "INVALID_REQUEST");
    assert.equal(
      withBody.error.message,
      "The request does not match the operation contract: this operation accepts no request body.",
    );
    assert.equal(
      (await request("GET", path, { headers: { "x-api-key": shortLived.data.key } })).status,
      200,
    );
    assert.equal(
      (await request("DELETE", `/api/auth/service-keys/${shortLived.data.id}`)).status,
      200,
    );
  });

  await t.test("key names count code points, as the schema and the CLI do", async () => {
    const tooLong =
      "The request does not match the operation contract: body /name is too long (expected at most 32 characters).";
    // 32 code points that are 64 UTF-16 units still fit, and the name round-trips.
    for (const name of ["😀".repeat(32), "\u{20000}".repeat(32), `${"a".repeat(31)}😀`]) {
      const named = await request("POST", "/api/auth/service-keys", { body: { ...body, name } });
      assert.equal(named.status, 201, name);
      assert.equal(named.data.name, name);
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${named.data.id}`)).status,
        200,
      );
    }
    const keysBefore = memoryDatabase.apikey.length;
    const over = await request("POST", "/api/auth/service-keys", {
      body: { ...body, name: "😀".repeat(33) },
    });
    assert.equal(over.status, 400);
    assert.equal(over.error.message, tooLong);
    assert.deepEqual(over.error.details, [{ path: "/name", code: "TOO_LONG" }]);
    // Should Better Auth still refuse a name the schema admitted, the caller gets the
    // schema's 400, not a dependency 503, and no key is stored.
    const createServiceKey = auth.createServiceKey;
    auth.createServiceKey = (input) => createServiceKey({ ...input, name: "a".repeat(65) });
    try {
      const refused = await issue();
      assert.equal(refused.status, 400);
      assert.equal(refused.error.code, "INVALID_REQUEST");
      assert.equal(refused.error.message, tooLong);
      assert.deepEqual(refused.error.details, [{ path: "/name", code: "TOO_LONG" }]);
    } finally {
      auth.createServiceKey = createServiceKey;
    }
    assert.equal(memoryDatabase.apikey.length, keysBefore);
  });

  await t.test(
    "expired credentials and a removed IAM identity cannot authenticate an authorized request",
    async () => {
      const expiring = await issue();
      assert.equal(expiring.status, 201);
      const authContext = await auth.auth.$context;
      await authContext.adapter.update({
        model: "apikey",
        where: [{ field: "id", value: expiring.data.id }],
        update: { expiresAt: new Date(Date.now() - 1000) },
      });
      assert.equal(
        (await request("GET", path, { headers: { "x-api-key": expiring.data.key } })).status,
        401,
      );
      const at = policy.identities.indexOf(principal);
      policy.identities.splice(at, 1);
      const binding = policy.bindings.find((entry) => entry.subjectId === principal.id);
      policy.bindings.splice(policy.bindings.indexOf(binding), 1);
      assert.equal((await request("GET", path, { headers })).status, 403);
      policy.identities.push(principal);
      policy.bindings.push(binding);
    },
  );

  await t.test("a key record altered after issuance fails closed", async () => {
    const altered = await issue();
    assert.equal(altered.status, 201);
    const keyHeaders = { "x-api-key": altered.data.key };
    const read = async () => (await request("GET", path, { headers: keyHeaders })).status;
    assert.equal(await read(), 200);
    const authContext = await auth.auth.$context;
    const where = [{ field: "id", value: altered.data.id }];
    const record = await authContext.adapter.findOne({ model: "apikey", where });
    const { expiresAt, configId } = record;
    const encoded = typeof record.metadata === "string";
    const metadata = encoded ? JSON.parse(record.metadata) : record.metadata;
    assert.equal(metadata.namespaceId, namespaceId);
    const alter = ({ referenceId = record.referenceId, ...changes }) =>
      authContext.adapter.update({
        model: "apikey",
        where,
        update: {
          referenceId,
          metadata: encoded
            ? JSON.stringify({ ...metadata, ...changes })
            : { ...metadata, ...changes },
        },
      });
    // Each altered subject below holds the same Namespace grant as the issued key.
    const grant = (identity) => {
      policy.identities.push(identity);
      bindRole(policy, identity.id, {
        id: `altered-${identity.id}`,
        roleId: "tenant-automation",
        namespaceId,
      });
    };
    const agentPrincipal = {
      kind: "service_principal",
      id: `sp_${randomUUID()}`,
      namespaceId,
      agentId: `agt_${randomUUID()}`,
    };
    const unscopedPrincipal = { kind: "service_principal", id: `sp_${randomUUID()}` };
    grant(agentPrincipal);
    grant(unscopedPrincipal);
    try {
      // Another Installation's key is not a credential here at all.
      await alter({ installationId: `ins_${randomUUID()}` });
      assert.equal(await read(), 401);
      // An Agent's own service principal never acts through a service key.
      await alter({ referenceId: agentPrincipal.id });
      assert.equal(await read(), 403);
      // A Namespace key cannot name an Installation-scoped service principal.
      await alter({ referenceId: unscopedPrincipal.id });
      assert.equal(await read(), 403);
      // A record without a service principal or without an expiry is not a credential: the
      // caller is unauthenticated (401), not facing a dependency outage (503).
      await alter({ referenceId: "" });
      assert.equal(await read(), 401);
      await alter({});
      await authContext.adapter.update({ model: "apikey", where, update: { expiresAt: null } });
      assert.equal(await read(), 401);
      await authContext.adapter.update({ model: "apikey", where, update: { expiresAt } });
      assert.equal(await read(), 200);
      // Another key configuration's record is neither a credential nor revocable here.
      await authContext.adapter.update({ model: "apikey", where, update: { configId: "default" } });
      assert.equal(await read(), 401);
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${altered.data.id}`)).status,
        404,
      );
      await authContext.adapter.update({ model: "apikey", where, update: { configId } });
      assert.equal(await read(), 200);
    } finally {
      await authContext.adapter.update({ model: "apikey", where, update: { expiresAt, configId } });
      await alter({});
      for (const identity of [agentPrincipal, unscopedPrincipal]) {
        policy.identities.splice(policy.identities.indexOf(identity), 1);
        policy.bindings.splice(
          policy.bindings.findIndex((binding) => binding.subjectId === identity.id),
          1,
        );
      }
    }
  });

  await t.test(
    "HTTP revocation rejects the key, preserves sessions, and never exposes the credential",
    async () => {
      const revoked = await request("DELETE", `/api/auth/service-keys/${issued.data.id}`);
      assert.equal(revoked.status, 200);
      assert.equal(revoked.data.revoked, true);
      assert.equal(JSON.stringify(revoked).includes(issued.data.key), false);
      assert.equal(
        (await request("GET", path, { headers: { ...headers, cookie: session.cookie } })).status,
        401,
      );
      assert.equal((await request("GET", "/installation")).status, 200);
      const events = auditSink.events;
      assert.equal(JSON.stringify(events).includes(issued.data.key), false);
      assert.ok(
        events.some(
          (event) =>
            event.action === "openclaw.auth.service-keys.create" &&
            event.actorId === seed.principal.id,
        ),
      );
      assert.ok(events.some((event) => event.action === "openclaw.auth.service-keys.revoke"));
      assert.ok(
        events.some(
          (event) => event.kind === "authorization_denial" && event.actorId === principal.id,
        ),
      );
    },
  );
});

// Issuing a key hands the caller every grant of the target ServicePrincipal, so
// Installation administer alone must not reach a principal with broader access.
test("service key issuance cannot exceed the caller's own IAM grants", async (t) => {
  const installationId = `ins_${randomUUID()}`;
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const baseURL = "http://127.0.0.1";
  const auth = createControllerAuth({
    installationId,
    mode: "development",
    baseURL,
    secret: `test-secret-${randomUUID()}`,
    memoryDatabase,
    secureCookies: false,
  });
  const adminCredentials = {
    email: "admin@example.invalid",
    password: `test-password-${randomUUID()}`,
  };
  const operatorCredentials = {
    email: "operator@example.invalid",
    password: `test-password-${randomUUID()}`,
  };
  const admin = auth.principalSeed(await auth.createAccount(adminCredentials), {
    grant: "administrator",
  });
  const administratorRole = admin.roles[0];
  // POST /api/auth/accounts with the administrator roleId binds it to the exact Installation.
  const operator = auth.principalSeed(await auth.createAccount(operatorCredentials), {
    roleId: administratorRole.id,
  });
  // Same shape as the bootstrap ServicePrincipal: the administrator Role, unscoped.
  const bootstrapService = { kind: "service_principal", id: `spn_${randomUUID()}` };
  const installationService = { kind: "service_principal", id: `spn_${randomUUID()}` };
  const policy = {
    identities: [admin.principal, operator.principal, bootstrapService, installationService],
    roles: [
      ...admin.roles,
      {
        id: "installation-iam",
        permissions: [{ action: "administer", resourceKind: "installation" }],
      },
    ],
    bindings: [
      ...admin.bindings,
      ...operator.bindings,
      {
        id: "bootstrap-service-admin",
        subjectKind: "identity",
        subjectId: bootstrapService.id,
        roleId: administratorRole.id,
      },
      {
        id: "installation-service-iam",
        subjectKind: "identity",
        subjectId: installationService.id,
        roleId: "installation-iam",
        resourceKind: "installation",
        resourceId: installationId,
      },
    ],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const auditSink = new InMemoryAuditSink();
  const app = createFastifyApp({
    auth,
    iamDriver: new NativeIAMDriver({ loadNativeIAMState: async () => policy }),
    auditSink,
    development: { enabled: true, installationId },
    computeDriver: createDevelopmentComputeDriver(),
    secretDriver: createTestSecretDriver(),
    configurationDriver: createTestConfigurationDriver(),
    resolveHarness: resolveApprovedDevelopmentHarness,
    createController(installation) {
      return new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const adminSession = await signInWithEmailPassword({ origin, ...adminCredentials });
  const operatorSession = await signInWithEmailPassword({ origin, ...operatorCredentials });
  async function request(method, path, { headers, body } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        origin: baseURL,
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, ...(await response.json()) };
  }
  const asAdmin = { cookie: adminSession.cookie };
  const asOperator = { cookie: operatorSession.cookie };
  assert.equal(
    (await request("POST", "/installation/bootstrap", { headers: asAdmin, body: { name: "t" } }))
      .status,
    201,
  );
  const namespace = await request("POST", "/namespaces", {
    headers: asAdmin,
    body: { name: "tenant" },
  });
  assert.equal(namespace.status, 201);
  const namespacePath = `/namespaces/${namespace.data.id}`;

  // The operator's grant stops at the exact Installation.
  assert.equal((await request("GET", "/installation", { headers: asOperator })).status, 200);
  assert.equal((await request("GET", namespacePath, { headers: asOperator })).status, 403);

  const escalation = await request("POST", "/api/auth/service-keys", {
    headers: asOperator,
    body: { servicePrincipalId: bootstrapService.id, name: "escalation" },
  });
  assert.equal(escalation.status, 403, JSON.stringify(escalation));
  assert.equal(JSON.stringify(escalation).includes("occ_"), false);
  assert.equal(memoryDatabase.apikey.length, 0);
  assert.ok(
    auditSink.events.some(
      (event) =>
        event.action === "openclaw.auth.service-keys.create" &&
        event.kind === "authorization_denial" &&
        event.actorId === operator.principal.id,
    ),
  );

  // A principal whose grants the operator already holds is still issuable.
  const covered = await request("POST", "/api/auth/service-keys", {
    headers: asOperator,
    body: { servicePrincipalId: installationService.id, name: "covered" },
  });
  assert.equal(covered.status, 201, JSON.stringify(covered));

  // The unscoped administrator holds every grant of the bootstrap principal.
  const bootstrapKey = await request("POST", "/api/auth/service-keys", {
    headers: asAdmin,
    body: { servicePrincipalId: bootstrapService.id, name: "bootstrap" },
  });
  assert.equal(bootstrapKey.status, 201, JSON.stringify(bootstrapKey));
  assert.equal(
    (await request("GET", namespacePath, { headers: { "x-api-key": bootstrapKey.data.key } }))
      .status,
    200,
  );
  const coverageDenial = auditSink.events.find(
    (event) =>
      event.action === "openclaw.auth.service-keys.create" &&
      event.kind === "authorization_denial" &&
      event.actorId === operator.principal.id,
  );
  assert.equal(coverageDenial.reasonCode, "SERVICE_PRINCIPAL_GRANTS_NOT_COVERED");
  assert.match(coverageDenial.decisionReason, /every grant of the target ServicePrincipal/);
  assert.equal(coverageDenial.details.servicePrincipalId, bootstrapService.id);

  // The administrator Role grants Agent administer but not read_logs. Administer already
  // admits log reads, so it covers a principal that was delegated read_logs on an Agent.
  const logReader = {
    kind: "service_principal",
    id: `spn_${randomUUID()}`,
    namespaceId: namespace.data.id,
  };
  policy.identities.push(logReader);
  grantRole(policy, logReader.id, {
    id: "agent-log-reader",
    bindingId: "agent-log-reader-binding",
    namespaceId: namespace.data.id,
    permissions: { agent: ["read", "read_logs"] },
    resource: { kind: "agent", id: `agt_${randomUUID()}` },
  });
  const logReaderKey = await request("POST", "/api/auth/service-keys", {
    headers: asAdmin,
    body: { servicePrincipalId: logReader.id, namespaceId: namespace.data.id, name: "logs" },
  });
  assert.equal(logReaderKey.status, 201, JSON.stringify(logReaderKey));
  assert.equal(
    (
      await request("DELETE", `/api/auth/service-keys/${logReaderKey.data.id}`, {
        headers: asAdmin,
      })
    ).status,
    200,
  );

  // Revocation needs the same authority as issuance.
  const revokePath = `/api/auth/service-keys/${bootstrapKey.data.id}`;
  const revokeEscalation = await request("DELETE", revokePath, { headers: asOperator });
  assert.equal(revokeEscalation.status, 403, JSON.stringify(revokeEscalation));
  assert.equal(
    (await request("GET", namespacePath, { headers: { "x-api-key": bootstrapKey.data.key } }))
      .status,
    200,
  );
  const revokeDenial = auditSink.events.find(
    (event) =>
      event.action === "openclaw.auth.service-keys.revoke" &&
      event.kind === "authorization_denial" &&
      event.actorId === operator.principal.id,
  );
  assert.equal(revokeDenial.reasonCode, "SERVICE_PRINCIPAL_GRANTS_NOT_COVERED");
  assert.equal(revokeDenial.details.servicePrincipalId, bootstrapService.id);
  assert.equal(revokeDenial.details.serviceKeyId, bootstrapKey.data.id);
  // The operator can still revoke a key whose principal it covers.
  assert.equal(
    (await request("DELETE", `/api/auth/service-keys/${covered.data.id}`, { headers: asOperator }))
      .status,
    200,
  );
  assert.equal((await request("DELETE", revokePath, { headers: asAdmin })).status, 200);
  assert.equal(
    (await request("GET", namespacePath, { headers: { "x-api-key": bootstrapKey.data.key } }))
      .status,
    401,
  );
});
