import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type {
  Agent,
  Namespace,
  PreparedGitHubEgressSource,
  PreparedTokenRef,
  SecretDriver,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import type { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/access/clock.ts";
import { PostgresPreparedGitHubLifecycle } from "../../apps/controller/src/drivers/repo/github/access/prepared-lifecycle.ts";
import {
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepositoryId,
  fixtureRepository,
} from "../fixtures/repository-credentials/github.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { bindRuntimeSource } from "../helpers/postgres-protected-scenarios.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import {
  record,
  resourceId,
  startLifecycleGitHub,
  wireResponses,
  type GitHubFixtureOptions,
  type LifecycleEgress,
  callFixture,
  deployedEgress,
} from "./postgres-prepared-github-wire.ts";

interface HttpReply {
  readonly status: number;
  readonly body: unknown;
  readonly data: unknown;
}

type Request = (method: string, path: string, options?: { body?: unknown }) => Promise<HttpReply>;

interface PostgresApp {
  readonly state: PostgresPlatformState;
  readonly controller: OpenClawController;
  readonly pool: Pool;
  readonly request: Request;
}

const openPostgresApp: (
  t: TestContext,
  options: { poolOptions: { max: number; connectionTimeoutMillis: number } },
) => Promise<PostgresApp> = postgresApp;

function issuerSecret(secret: unknown) {
  assert.ok(record(secret));
  const id = resourceId(secret);
  const { ref } = secret;
  assert.ok(record(ref) && ref.kind === "secret" && typeof ref.namespaceId === "string");
  assert.equal(resourceId(ref), id);
  return {
    id,
    ref: { kind: ref.kind, id, namespaceId: ref.namespaceId } satisfies SecretReference,
  };
}

export async function findPreparedSource(
  state: PostgresPlatformState,
  namespaceId: string,
  id: string,
): Promise<PreparedGitHubEgressSource> {
  const stored = await state.read((view) =>
    view.credentialSources.findCredentialSource(namespaceId, id),
  );
  const egress = stored?.egress;
  assert.ok(egress?.schemaVersion === 2 && egress.grant.kind === "github_repository_metadata");
  return { ...egress, schemaVersion: egress.schemaVersion, grant: egress.grant };
}

interface Registration {
  type: "github-app-metadata";
  name: string;
  config: Readonly<Record<string, string>>;
  secrets: { private_key: SecretReference };
}

/**
 * A prepared GitHub metadata source registered through the real API, bound to an Agent, over
 * PostgreSQL and a synthetic HTTPS GitHub App issuer. Both keys are generated here; only the
 * dedicated issuer Secret receives the private App key.
 */
export async function preparedLifecycleFixture(
  t: TestContext,
  githubOptions: GitHubFixtureOptions = {},
  now?: () => Date,
) {
  const dir = await temporaryDirectory(t, "occ-prepared-gh-");
  const key = join(dir, "custody.key");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  const gh = await startLifecycleGitHub(t, createSystemClock(), githubOptions);
  const secretValue = gh.privateKey.export({ format: "pem", type: "pkcs8" });
  let owner:
    | {
        lifecycle: PostgresPreparedGitHubLifecycle;
        tokens: TokenService;
        secretDriver: SecretDriver;
      }
    | undefined;
  let tokenRegistration: { kind: string; reference: PreparedTokenRef } | undefined;
  let issuer: ReturnType<typeof issuerSecret> | undefined;
  let sourceId: string | undefined;
  let registration: Registration | undefined;
  let postgres: PostgresApp | undefined;
  const createOwner = (origin = gh.origin, tokenService?: TokenService) => {
    assert.ok(owner);
    return new PostgresPreparedGitHubLifecycle(
      key,
      owner.secretDriver,
      origin,
      gh.tls.ca,
      tokenService,
    );
  };
  const options = {
    secretValue,
    protectedSourceOnly: true,
    ...(now && { now }),
    createPreparedGitHub({
      secretDriver,
      tokenService,
    }: {
      secretDriver: SecretDriver;
      tokenService: TokenService;
    }) {
      const register = tokenService.register.bind(tokenService);
      t.mock.method(
        tokenService,
        "register",
        async (...[input, signal]: Parameters<TokenService["register"]>) => {
          const reference = await register(input, signal);
          tokenRegistration = { kind: input.kind, reference };
          return reference;
        },
        { times: 1 },
      );
      const lifecycle = new PostgresPreparedGitHubLifecycle(
        key,
        secretDriver,
        gh.origin,
        gh.tls.ca,
        tokenService,
      );
      owner = { lifecycle, tokens: tokenService, secretDriver };
      return lifecycle;
    },
    async appFactory(t: TestContext, opts: unknown): Promise<PostgresApp> {
      assert.ok(owner && record(opts));
      const { tokens, lifecycle, secretDriver } = owner;
      const app: PostgresApp = await openPostgresApp(t, {
        ...opts,
        poolOptions: { max: 1, connectionTimeoutMillis: 2000 },
      });
      postgres = app;
      // Production can register saved OAuth accounts and the GitHub issuer on the same Token Service.
      tokens.registerIssuer(
        new OAuthAccountTokens(
          app.state,
          secretDriver,
          app.controller.resolveConnectionClient.bind(app.controller),
        ),
      );
      await lifecycle.connect(app.pool);
      t.after(() => lifecycle.close());
      return app;
    },
    async admitSource({
      app,
      agent,
      namespace,
      secret,
      path,
    }: {
      app: PostgresApp;
      agent: Pick<Agent, "id" | "configurationId">;
      namespace: Pick<Namespace, "id">;
      secret: unknown;
      path: string;
    }) {
      issuer = issuerSecret(secret);
      registration = {
        type: "github-app-metadata",
        name: "prepared-repository",
        config: {
          authority: "execution",
          app_id: fixtureAppId,
          installation_id: fixtureInstallationId,
          repository_id: fixtureRepositoryId,
          repository: fixtureRepository,
          agent_id: agent.id,
        },
        secrets: { private_key: issuer.ref },
      };
      const created = await app.request("POST", path, { body: registration });
      assert.equal(created.status, 201);
      sourceId = resourceId(created.data);
      const bound = await callFixture(bindRuntimeSource, undefined, [
        app,
        namespace,
        agent,
        created.data,
      ]);
      return bound;
    },
  };
  const raw = await callFixture(staticEgressFixture, undefined, [t, options]);
  assert.ok(deployedEgress(raw));
  assert.ok(postgres && owner && issuer && registration && sourceId && tokenRegistration);
  const { state, pool } = postgres;
  const { lifecycle, tokens } = owner;
  const namespace = { id: resourceId(raw.namespace) };
  const agent = { id: resourceId(raw.agent) };
  const { request } = postgres;
  const source = await findPreparedSource(state, namespace.id, sourceId);
  const wire: LifecycleEgress = {
    ...wireResponses(raw),
    installation: raw.installation,
    capture: raw.capture,
    permitRequest: raw.permitRequest,
    protect: raw.protect,
  };
  const f = {
    ...wire,
    state,
    pool,
    namespace,
    agent,
    request,
    revoke: raw.revoke,
    get secretReads() {
      return raw.secretReads;
    },
  };
  const sourceRegistration = registration;
  /** Register another prepared source with the same grant; no Agent revision holds it. */
  const registerSource = async (name: string) => {
    const path = `/namespaces/${namespace.id}/credential-sources`;
    const { status, data } = await request("POST", path, { body: { ...sourceRegistration, name } });
    assert.equal(status, 201);
    return resourceId(data);
  };
  return {
    gh,
    f,
    tokens,
    tokenRegistration,
    lifecycle,
    issuer,
    source,
    secretValue,
    createOwner,
    registerSource,
    registration,
  };
}

export type LifecycleFixture = Awaited<ReturnType<typeof preparedLifecycleFixture>>;
