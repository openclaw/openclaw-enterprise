import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { ServicePrincipal } from "../../packages/contracts/src/index.ts";
import type { NativeIAMState } from "../../packages/iam/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { bindRole, grantRole } from "../helpers/iam-grants.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

type MutableIAMState = { [K in keyof NativeIAMState]: NativeIAMState[K][number][] };
type HttpResult = Record<string, unknown> & { status: number };
type CliAssertions = {
  record(value: unknown): Record<string, unknown>;
  stringField(value: unknown, field: string): string;
  assertStringFields<K extends string>(
    value: Record<string, unknown>,
    ...fields: K[]
  ): asserts value is Record<string, unknown> & Record<K, string>;
  jsonValue(text: string): unknown;
};
type CliScenarioContext = {
  issued: HttpResult;
  origin: string;
  namespaceId: string;
  installationId: string;
  policy: Pick<MutableIAMState, "identities" | "roles" | "bindings">;
  request(
    method: string,
    path: string,
    options?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<HttpResult>;
  controller: Pick<OpenClawController, "handleNamespaceLifecycle" | "createSecret" | "updateAgent">;
  administratorId: string;
  principal: ServicePrincipal;
  keyCount(): number;
  setRotateKeyBeforeResponse(callback: (() => void) | undefined): void;
  getRotateKeyBeforeResponse(): (() => void) | undefined;
  assertions: CliAssertions;
};

const run = promisify(execFile);

export async function runServiceApiKeysCliScenario(
  t: TestContext,
  context: CliScenarioContext,
): Promise<void> {
  const {
    issued,
    origin,
    namespaceId,
    installationId,
    policy,
    request,
    controller,
    administratorId,
    principal,
    keyCount,
    setRotateKeyBeforeResponse,
    getRotateKeyBeforeResponse,
    assertions,
  } = context;
  const { record, stringField, jsonValue } = assertions;
  const assertStringFields: CliAssertions["assertStringFields"] = assertions.assertStringFields;

  const {
    directory,
    occCli,
    keyFile,
    adminKeyFile,
    bodyFile,
    ambiguousBodyFile,
    secretFile,
    secretUpdateFile,
    roleFile,
    env,
    installationPrincipal,
    adminEnv,
  } = await prepareCli();
  const cliSecret = await exerciseConfigurationAndSecret();
  await exercisePresets();
  const { agent, boundAgent } = await prepareAgent();
  const { role, binding } = await exerciseIam(cliSecret, boundAgent);
  await exerciseServiceKeys();
  await exerciseRefusals(role, boundAgent);
  await exerciseRuntimeAndCleanup(agent, binding, role, cliSecret);
  await exerciseRequestTimeRotation();

  function jsonRecord(text: string): Record<string, unknown> {
    return record(jsonValue(text));
  }

  function jsonRecords(text: string): Record<string, unknown>[] {
    const value = jsonValue(text);
    assert.ok(Array.isArray(value));
    return value.map((item: unknown) => record(item));
  }

  function commandError(
    error: unknown,
  ): asserts error is Error & { code: number; stdout: string; stderr: string } {
    assert.ok(error instanceof Error);
    assert.equal(typeof record(error).code, "number");
    assert.equal(typeof record(error).stdout, "string");
    assert.equal(typeof record(error).stderr, "string");
  }

  async function prepareCli() {
    const directory = await temporaryDirectory(t, "openclaw-occ-cli-");
    const occCli = join(directory, "occ");
    // Build the real CLI once, then exercise it through a live Fastify socket below.
    await run("go", ["build", "-trimpath", "-o", occCli, "./cmd/occ"]);
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
    const installationPrincipal: ServicePrincipal = {
      kind: "service_principal",
      id: `sp_${randomUUID()}`,
    };
    policy.identities.push(installationPrincipal);
    grantRole(policy, installationPrincipal.id, {
      id: "cli-installation-iam-administrator",
      namespaceId: undefined,
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
    return {
      directory,
      occCli,
      keyFile,
      adminKeyFile,
      bodyFile,
      ambiguousBodyFile,
      secretFile,
      secretUpdateFile,
      roleFile,
      env,
      installationPrincipal,
      adminEnv,
    };
  }

  async function exerciseConfigurationAndSecret() {
    // Reject ambiguous object members before a credentialed mutation can reach OCC.
    await assert.rejects(
      run(occCli, ["configuration", "create", "--file", ambiguousBodyFile], { env }),
      (error: unknown) => {
        commandError(error);
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
    const configuration = jsonRecord(created.stdout);
    assertStringFields(configuration, "id");
    const configurationPath = `/namespaces/${namespaceId}/configurations/${configuration.id}`;
    assert.equal(record(configuration.values).model, "gpt-test");

    // A bodyless 204 becomes a stable domain result instead of leaking transport details.
    const deleted = await run(
      occCli,
      ["configuration", "delete", configuration.id, "--output", "json"],
      { env },
    );
    assert.deepEqual(jsonValue(deleted.stdout), {
      deleted: true,
      id: configuration.id,
      kind: "configuration",
    });
    assert.equal((await request("GET", configurationPath)).status, 404);

    // Secret material and Agent runtime operations require a ready Namespace.
    const readyNamespace = await controller.handleNamespaceLifecycle(
      administratorId,
      namespaceId,
      "ready",
    );
    assert.ok(readyNamespace);
    assert.equal(readyNamespace.status, "ready");
    const secretCreated = await run(
      occCli,
      ["secret", "create", "--file", secretFile, "--output", "json"],
      { env },
    );
    const cliSecret = jsonRecord(secretCreated.stdout);
    assertStringFields(cliSecret, "id");
    assert.equal(cliSecret.name, "cli-secret");
    assert.equal(Object.hasOwn(cliSecret, "value"), false);
    const secretRead = await run(occCli, ["secret", "get", cliSecret.id, "--output", "json"], {
      env,
    });
    assert.equal(jsonRecord(secretRead.stdout).id, cliSecret.id);
    const secretUpdated = await run(
      occCli,
      ["secret", "update", cliSecret.id, "--file", secretUpdateFile, "--output", "json"],
      { env },
    );
    assert.deepEqual(jsonValue(secretUpdated.stdout), cliSecret);
    return cliSecret;
  }

  async function exercisePresets() {
    const preset = await request("POST", `/namespaces/${namespaceId}/presets`, {
      body: { name: "cli-preset", template: { agent: { name: "CLI Preset Agent" } } },
    });
    assert.equal(preset.status, 201);
    const presetList = await run(occCli, ["preset", "list", "-o", "json"], { env });
    assert.deepEqual(
      jsonRecords(presetList.stdout).map(({ id, name }) => ({ id, name })),
      [{ id: stringField(preset.data, "id"), name: "cli-preset" }],
    );
    const presetRead = await run(
      occCli,
      ["preset", "get", stringField(preset.data, "id"), "-o", "json"],
      {
        env,
      },
    );
    assert.deepEqual(jsonValue(presetRead.stdout), preset.data);
    await assert.rejects(
      run(occCli, ["preset", "delete", stringField(preset.data, "id")], { env }),
      (error: unknown) => {
        commandError(error);
        assert.match(error.stderr, /HTTP 403\)/);
        return true;
      },
    );
    assert.equal(
      (await request("GET", `/namespaces/${namespaceId}/presets/${stringField(preset.data, "id")}`))
        .status,
      200,
    );
    // The grant stays on the key's Role for the rest of this test.
    const automationRoleIndex = policy.roles.findIndex(
      (candidate) => candidate.id === "tenant-automation",
    );
    const automationRole = policy.roles[automationRoleIndex];
    assert.ok(automationRole);
    policy.roles[automationRoleIndex] = {
      ...automationRole,
      permissions: [...automationRole.permissions, { action: "delete", resourceKind: "preset" }],
    };
    const presetDeleted = await run(
      occCli,
      ["preset", "delete", stringField(preset.data, "id"), "--output", "json"],
      { env },
    );
    assert.deepEqual(jsonValue(presetDeleted.stdout), {
      deleted: true,
      id: stringField(preset.data, "id"),
      kind: "preset",
    });
    assert.equal(
      (await request("GET", `/namespaces/${namespaceId}/presets/${stringField(preset.data, "id")}`))
        .status,
      404,
    );
  }

  async function prepareAgent() {
    // Seed the server-owned resource through the administrator session so the
    // scoped CLI credential exercises only its granted Agent operations.
    const agentConfiguration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: { kind: "agent", values: {} },
    });
    assert.equal(agentConfiguration.status, 201);
    const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
      body: { name: "cli-stop-agent", configurationId: stringField(agentConfiguration.data, "id") },
    });
    assert.equal(agent.status, 201);
    const source = await controller.createSecret(administratorId, {
      namespaceId,
      name: "cli-model-key",
      value: "synthetic-cli-model-key",
    });
    const boundAgent = await controller.updateAgent(administratorId, {
      namespaceId,
      agentId: stringField(agent.data, "id"),
      configurationId: stringField(agentConfiguration.data, "id"),
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
    return { agent, boundAgent };
  }

  async function exerciseIam(
    cliSecret: Record<string, unknown> & { id: string },
    boundAgent: Pick<Awaited<ReturnType<OpenClawController["updateAgent"]>>, "servicePrincipalId">,
  ) {
    const roleCreated = await run(
      occCli,
      ["iam", "role", "create", "--file", roleFile, "-o", "json"],
      {
        env: adminEnv,
      },
    );
    const role = jsonRecord(roleCreated.stdout);
    assertStringFields(role, "id");
    assert.equal(role.name, "CLI secret operator");
    assert.deepEqual(role.permissions, [{ action: "operate", resourceKind: "secret" }]);
    const roleList = await run(occCli, ["iam", "role", "list", "-o", "json"], {
      env: adminEnv,
    });
    assert.ok(jsonRecords(roleList.stdout).some((candidate) => candidate.id === role.id));
    const roleRead = await run(occCli, ["iam", "role", "get", role.id, "-o", "json"], {
      env: adminEnv,
    });
    assert.deepEqual(jsonValue(roleRead.stdout), role);
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
    const binding = jsonRecord(bindingCreated.stdout);
    assertStringFields(binding, "id");
    assert.equal(binding.subjectId, boundAgent.servicePrincipalId);
    assert.equal(binding.roleId, role.id);
    assert.equal(binding.resourceId, cliSecret.id);
    const bindingList = await run(occCli, ["iam", "access-binding", "list", "-o", "json"], {
      env: adminEnv,
    });
    assert.ok(jsonRecords(bindingList.stdout).some((candidate) => candidate.id === binding.id));
    const bindingRead = await run(
      occCli,
      ["iam", "access-binding", "get", binding.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(jsonValue(bindingRead.stdout), binding);

    // An Installation administrator creates a Namespace ServicePrincipal for a member's CLI.
    // It holds no grant until an AccessBinding names it (proved with PostgreSQL policy in
    // postgres-service-api-keys.test.ts).
    const principalCreated = await run(
      occCli,
      ["iam", "service-principal", "create", "-o", "json"],
      { env: adminEnv },
    );
    const createdPrincipal = jsonRecord(principalCreated.stdout);
    assertStringFields(createdPrincipal, "id");
    assert.match(createdPrincipal.id, /^spn_/);
    assert.equal(createdPrincipal.namespaceId, namespaceId);
    const principalList = await run(occCli, ["iam", "service-principal", "list", "-o", "json"], {
      env: adminEnv,
    });
    assert.deepEqual(jsonValue(principalList.stdout), [createdPrincipal]);
    const principalRead = await run(
      occCli,
      ["iam", "service-principal", "get", createdPrincipal.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(jsonValue(principalRead.stdout), createdPrincipal);
    return { role, binding };
  }

  async function exerciseServiceKeys() {
    // occ service-key create writes a private key file that occ itself accepts, and never
    // prints the key. The administrator key covers its own grants, so it may rotate itself.
    const rotatedKeyFile = join(directory, "rotated-admin-key.json");
    const { OCC_NAMESPACE: _namespace, ...installationEnv } = adminEnv;
    const createServiceKey = (args: string[]) =>
      run(
        occCli,
        ["service-key", "create", "--service-principal", installationPrincipal.id, ...args],
        { env: installationEnv },
      );
    const rotated = await createServiceKey([
      "--name",
      "cli-rotated",
      "--expires-in-days",
      "2",
      "--out",
      rotatedKeyFile,
      "-o",
      "json",
    ]);
    const rotatedDetails = jsonRecord(rotated.stdout);
    assertStringFields(rotatedDetails, "id");
    assert.equal(rotatedDetails.servicePrincipalId, installationPrincipal.id);
    assert.equal(rotatedDetails.key, undefined);
    // Read mode and content through one handle so both describe the same file.
    const rotatedHandle = await open(rotatedKeyFile);
    let rotatedKey: Record<string, unknown>;
    try {
      assert.equal((await rotatedHandle.stat()).mode & 0o777, 0o600);
      rotatedKey = record(jsonRecord(await rotatedHandle.readFile("utf8")).data);
    } finally {
      await rotatedHandle.close();
    }
    assertStringFields(rotatedKey, "key");
    assert.equal(rotatedKey.id, rotatedDetails.id);
    assert.ok(!rotated.stdout.includes(rotatedKey.key));
    const rotatedEnv = { ...adminEnv, OCC_SERVICE_KEY_FILE: rotatedKeyFile };
    await run(occCli, ["iam", "service-principal", "list"], { env: rotatedEnv });
    // An existing file is never overwritten, and no key is issued for it.
    const keysBeforeClobber = keyCount();
    await assert.rejects(
      createServiceKey(["--name", "cli-clobber", "--out", rotatedKeyFile]),
      /failed to create key file/,
    );
    assert.equal(keyCount(), keysBeforeClobber);
    // An explicit zero is invalid, not the API's omitted 30-day default.
    const zeroExpiryFile = join(directory, "zero-expiry-key.json");
    await assert.rejects(
      createServiceKey(["--name", "zero-expiry", "--out", zeroExpiryFile, "--expires-in-days=0"]),
      { stderr: /between 1 and 365/ },
    );
    await assert.rejects(open(zeroExpiryFile), { code: "ENOENT" });
    assert.equal(keyCount(), keysBeforeClobber);
    for (const days of [1, 365]) {
      const before = Date.now();
      const created = jsonRecord(
        (
          await createServiceKey([
            "--name",
            `expiry-${days}`,
            "--out",
            join(directory, `expiry-${days}.json`),
            `--expires-in-days=${days}`,
            "-o",
            "json",
          ])
        ).stdout,
      );
      assertStringFields(created, "expiresAt", "id");
      assert.ok(Math.abs(Date.parse(created.expiresAt) - before - days * 86_400_000) < 10_000);
      await run(occCli, ["service-key", "revoke", created.id], { env: adminEnv });
    }
    assert.equal(keyCount(), keysBeforeClobber);
    // The CLI counts the name as the API does: 32 emoji are issued, 33 never leave the CLI.
    const emojiKeyFile = join(directory, "emoji-key.json");
    const emoji = jsonRecord(
      (await createServiceKey(["--name", "😀".repeat(32), "--out", emojiKeyFile, "-o", "json"]))
        .stdout,
    );
    assertStringFields(emoji, "id");
    assert.equal(emoji.name, "😀".repeat(32));
    await assert.rejects(
      createServiceKey([
        "--name",
        "😀".repeat(33),
        "--out",
        join(directory, "emoji-33.json"),
        "-o",
        "json",
      ]),
      { stderr: /1 to 32 characters/ },
    );
    assert.equal(keyCount(), keysBeforeClobber + 1);
    await run(occCli, ["service-key", "revoke", emoji.id], { env: adminEnv });
    const revokedRotated = await run(
      occCli,
      ["service-key", "revoke", rotatedDetails.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(jsonValue(revokedRotated.stdout), { id: rotatedDetails.id, revoked: true });
    // A revoked key's 401 names the key file and who issues a new key, not OCC's cookie and
    // header advice (finding D745).
    await assert.rejects(run(occCli, ["iam", "service-principal", "list"], { env: rotatedEnv }), {
      stderr:
        /^Error: OCC rejected the service key in \S+rotated-admin-key\.json: it is invalid, expired or revoked\. Ask an Installation administrator for a new key\.\n$/,
    });
  }

  async function exerciseRefusals(
    role: Record<string, unknown> & { id: string },
    boundAgent: Pick<Awaited<ReturnType<OpenClawController["updateAgent"]>>, "servicePrincipalId">,
  ) {
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
      (error: unknown) => {
        commandError(error);
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
      resource: undefined,
      namespaceId,
      permissions: { credential_source: ["create"] },
    });
    const sourceFile = join(directory, "credential-source.json");
    await writeFile(sourceFile, JSON.stringify({ name: "openai-key", type: "openai" }), {
      mode: 0o600,
    });
    await assert.rejects(
      run(occCli, ["credential-source", "create", "--file", sourceFile], { env }),
      (error: unknown) => {
        commandError(error);
        assert.match(
          error.stderr,
          /HTTP 409\): CREDENTIAL_GATEWAY_NOT_CONFIGURED: This Installation has no Credential Gateway.*docs-enterprise\.openclaw\.org\/reference\/credential-sources\//,
        );
        return true;
      },
    );
  }

  async function exerciseRuntimeAndCleanup(
    agent: HttpResult,
    binding: Record<string, unknown> & { id: string },
    role: Record<string, unknown> & { id: string },
    cliSecret: Record<string, unknown> & { id: string },
  ) {
    const runtimeInitial = await run(
      occCli,
      ["agent", "runtime-credentials", "get", stringField(agent.data, "id"), "-o", "json"],
      { env },
    );
    assert.deepEqual(jsonValue(runtimeInitial.stdout), { transportConfigured: false });
    const runtimeProvisioned = await run(
      occCli,
      ["agent", "runtime-credentials", "provision", stringField(agent.data, "id"), "-o", "json"],
      { env },
    );
    const runtimeMetadata = jsonRecord(runtimeProvisioned.stdout);
    assert.equal(runtimeMetadata.transportConfigured, true);
    const deployed = await request(
      "POST",
      `/namespaces/${namespaceId}/agents/${stringField(agent.data, "id")}/deploy`,
    );
    assert.equal(deployed.status, 202);
    assert.equal(
      record(
        (await request("GET", `/namespaces/${namespaceId}/agents/${stringField(agent.data, "id")}`))
          .data,
      ).desiredRuntimeState,
      "running",
    );

    const stopped = await run(occCli, ["agent", "stop", stringField(agent.data, "id")], { env });
    assert.match(stopped.stdout, /DESIRED STATE/);
    assert.match(stopped.stdout, new RegExp(`${stringField(agent.data, "id")}.*stopped`));
    const current = await run(
      occCli,
      ["agent", "get", stringField(agent.data, "id"), "--output", "json"],
      {
        env,
      },
    );
    const currentAgent = jsonRecord(current.stdout);
    assert.deepEqual(
      {
        id: currentAgent.id,
        desiredRuntimeState: currentAgent.desiredRuntimeState,
      },
      { id: stringField(agent.data, "id"), desiredRuntimeState: "stopped" },
    );
    const bindingDeleted = await run(
      occCli,
      ["iam", "access-binding", "delete", binding.id, "-o", "json"],
      { env: adminEnv },
    );
    assert.deepEqual(jsonValue(bindingDeleted.stdout), {
      deleted: true,
      id: binding.id,
      kind: "iam access-binding",
    });
    const roleDeleted = await run(occCli, ["iam", "role", "delete", role.id, "-o", "json"], {
      env: adminEnv,
    });
    assert.deepEqual(jsonValue(roleDeleted.stdout), {
      deleted: true,
      id: role.id,
      kind: "iam role",
    });
    const secretDeleted = await run(occCli, ["secret", "delete", cliSecret.id, "-o", "json"], {
      env,
    });
    assert.deepEqual(jsonValue(secretDeleted.stdout), {
      deleted: true,
      id: cliSecret.id,
      kind: "secret",
    });
    assert.equal(
      (await request("GET", `/namespaces/${namespaceId}/secrets/${cliSecret.id}`)).status,
      404,
    );

    const deleting = await run(occCli, ["agent", "delete", stringField(agent.data, "id")], { env });
    assert.match(deleting.stdout, /LIFECYCLE/);
    assert.match(deleting.stdout, new RegExp(`${stringField(agent.data, "id")}.*deleting`));
    const deletingAgent = await run(
      occCli,
      ["agent", "get", stringField(agent.data, "id"), "--output", "json"],
      {
        env,
      },
    );
    assert.equal(jsonRecord(deletingAgent.stdout).status, "deleting");
  }

  async function exerciseRequestTimeRotation() {
    setRotateKeyBeforeResponse(() => renameSync(adminKeyFile, keyFile));
    try {
      await assert.rejects(
        run(occCli, ["installation", "get", "--output", "json"], { env }),
        (error: unknown) => {
          commandError(error);
          assert.equal(error.code, 1);
          assert.equal(error.stdout, "");
          assert.match(error.stderr, /FORBIDDEN/);
          assert.match(error.stderr, /HTTP 403/);
          // The hint names the Namespace of the key this request sent, not the rotated one, and
          // asks for an Installation-scoped key rather than a --namespace (finding D740), without
          // repeating OCC's own sentence (finding D770).
          assert.ok(
            error.stderr.includes(
              `"occ installation get" needs an Installation-scoped key; no --namespace value helps. Read this key's Namespace with "occ namespace get ${namespaceId}".`,
            ),
          );
          assert.equal(error.stderr.split("works only in").length, 2);
          return true;
        },
      );
      // A new command reads the replacement Installation key; only the refused one used the old key.
      assert.equal(
        getRotateKeyBeforeResponse(),
        undefined,
        "rotated the key before delivering the 403",
      );
    } finally {
      setRotateKeyBeforeResponse(undefined);
    }
    await run(occCli, ["iam", "service-principal", "list"], { env });
  }
}
