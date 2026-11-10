import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthAccountRoleNotFoundError } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  createControllerApp,
  type ControllerApp,
  type ControllerAppOptions,
} from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type { ChatGPTBackendDefinition } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

type ControllerOptions = NonNullable<ConstructorParameters<typeof OpenClawController>[1]>;
type FixturePlatformState = NonNullable<ControllerOptions["state"]>;
type FixtureBackends =
  readonly [] | readonly [ChatGPTBackendDefinition, ...NonNullable<ControllerOptions["backends"]>];
type ProvisionAuthAccount = NonNullable<ControllerAppOptions["provisionAuthAccount"]>;
type AuthSeed = Parameters<ProvisionAuthAccount>[0];
type AuditEvent = Parameters<ProvisionAuthAccount>[1];
type IdentityWithId = Pick<AuthSeed["principal"], "id">;
type MutableIamState = {
  -readonly [Key in keyof NativeIAMState]: NativeIAMState[Key][number][];
};
type FixtureSession = Awaited<ReturnType<typeof signInToControllerApp>>;
type SessionApp = { defaultSession: FixtureSession | undefined };
type SeedOptions = { auditEvent?: AuditEvent | undefined };

interface InjectedFixtureOptions extends Partial<
  Pick<
    ControllerAppOptions,
    | "iamDriver"
    | "computeDriver"
    | "auditSink"
    | "configurationDriver"
    | "secretDriver"
    | "channelDriver"
    | "readManagedMcpToolNames"
    | "logger"
  >
> {
  readonly recordOperations?: ControllerOptions["recordOperations"];
  readonly backends?: FixtureBackends | undefined;
  readonly backendSummaries?: ControllerAppOptions["backendSummaries"];
  readonly provisionAuthAccount?: (
    seed: AuthSeed,
    context: {
      installAuthSeed(seed: AuthSeed, options?: SeedOptions): Promise<void>;
      state: MutableIamState;
      auditEvent: AuditEvent;
    },
  ) => Promise<void>;
}

type ApplicationFactory<App extends object> = (options: ControllerAppOptions) => App;
type InjectedAppOptions = Omit<ControllerAppOptions, "backendSummaries"> &
  Pick<InjectedFixtureOptions, "backendSummaries">;

interface FixtureAdapters {
  wrapPlatformState(state: InMemoryPlatformState): FixturePlatformState;
  invokeApplication<App extends object>(
    factory: ApplicationFactory<App>,
    options: InjectedAppOptions,
  ): App;
}

interface InjectedRequestOptions {
  readonly identity?: boolean | undefined;
  readonly session?: Pick<FixtureSession, "cookie" | "origin"> | string | null | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
  readonly rawBody?: RequestInit["body"];
}

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const identifier = (prefix: string) => new RegExp(`^${prefix}_${uuidV4}$`);

export async function createInjectedControllerFixture(
  options: InjectedFixtureOptions,
  adapters: FixtureAdapters,
) {
  const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
  const authFixture = await createTestAuthPrincipal({
    installationId,
    email: `admin-${randomUUID()}@example.com`,
    password: `generated-password-${randomUUID()}`,
    name: "OCC API Administrator",
  });
  const principal = authFixture.seed.principal;
  const state: MutableIamState = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: authFixture.seed.roles.map((role) => ({
      ...role,
      permissions: [...role.permissions],
    })),
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: authFixture.seed.roles[0]!.id,
      },
    ],
    restrictions: [],
  };
  const iamDriver =
    options.iamDriver ??
    new NativeIAMDriver({ loadNativeIAMState: async () => state }, { id: "iam-integration" });
  const computeCalls: { ensureNamespace: string[]; deleteNamespace: string[] } = {
    ensureNamespace: [],
    deleteNamespace: [],
  };
  const computeDriver =
    options.computeDriver ??
    createReadyComputeDriver("compute-integration", {
      async ensureNamespace(namespace) {
        computeCalls.ensureNamespace.push(namespace.id);
        return {
          namespaceId: namespace.id,
          namespaceReady: true,
        };
      },
      async deleteNamespace(namespace) {
        computeCalls.deleteNamespace.push(namespace.id);
        return {
          namespaceId: namespace.id,
          namespaceDeleted: true,
        };
      },
      // OCC API coverage exercises admission; runtime compatibility belongs to Compute suites.
      validateHarnessAuth() {},
      async stopRevision() {},
    });
  const auditSink = options.auditSink ?? new InMemoryAuditSink();
  const configurationDriver =
    options.configurationDriver ??
    createTestConfigurationDriver({ id: "configuration-integration" });
  const secretDriver =
    options.secretDriver ?? createTestSecretDriver({ id: "secret-api-integration" });
  const sessionsByPrincipalId = new Map<string, FixtureSession>();
  let controller: OpenClawController | undefined;
  let platformState: FixturePlatformState | undefined;

  async function installAuthSeed(seed: AuthSeed, { auditEvent }: SeedOptions = {}) {
    const roleIds = new Set(state.roles.map((role) => role.id));
    for (const binding of seed.bindings) {
      if (!roleIds.has(binding.roleId)) {
        throw new AuthAccountRoleNotFoundError(binding.roleId);
      }
    }
    state.identities.push(seed.principal);
    state.roles.push(...seed.roles);
    state.bindings.push(...seed.bindings);
    if (auditEvent !== undefined) {
      await auditSink.append(auditEvent);
    }
  }

  function createApp(identity?: IdentityWithId): ControllerApp & SessionApp;
  function createApp<App extends object>(
    identity: IdentityWithId | undefined,
    createApplication: ApplicationFactory<App>,
  ): App & SessionApp;
  function createApp(
    identity: IdentityWithId = principal,
    createApplication: ApplicationFactory<object> = createControllerApp,
  ) {
    const created = adapters.invokeApplication(createApplication, {
      ...(controller
        ? { controller }
        : {
            createController(installation) {
              const baseState = new InMemoryPlatformState({
                auditSink,
                resolveIAMIdentity: (identityId) =>
                  state.identities.find((identity) => identity.id === identityId),
              });
              platformState = adapters.wrapPlatformState(baseState);
              controller = new OpenClawController(installation, {
                state: platformState,
                recordOperations: options.recordOperations ?? false,
                ...(options.backends === undefined ? {} : { backends: options.backends }),
              });
              if (options.channelDriver) {
                controller.registerDriver(options.channelDriver);
                controller.selectDriver("channel", options.channelDriver.id);
              }
              if (options.backends?.length) {
                // Association alone must never provision an upstream account or credential.
                const backend = options.backends[0]!;
                const driverId = backend.drivers.service_account;
                const unexpectedBackendCall = async () => assert.fail("Unexpected Backend call");
                controller.registerDriver({
                  id: driverId,
                  implementation: "chatgpt",
                  capability: "service_account",
                  backendId: backend.id,
                  create: unexpectedBackendCall,
                  createCredential: unexpectedBackendCall,
                  delete: unexpectedBackendCall,
                });
                controller.selectDriver("service_account", driverId);
              }
              return controller;
            },
          }),
      iamDriver,
      computeDriver,
      configurationDriver,
      secretDriver,
      resolveHarness: resolveApprovedDevelopmentHarness,
      auditSink,
      ...(Object.hasOwn(options, "backendSummaries")
        ? { backendSummaries: options.backendSummaries }
        : {}),
      development: {
        enabled: true,
        browserOrigin: "https://console.oce.localhost",
        installationId,
      },
      auth: authFixture.auth,
      ...(options.readManagedMcpToolNames === undefined
        ? {}
        : { readManagedMcpToolNames: options.readManagedMcpToolNames }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.provisionAuthAccount === undefined
        ? {}
        : {
            // The memory composition has no State transaction; write the prepared
            // account first and remove it when the fixture's provisioning fails.
            provisionAuthAccount: async (seed, auditEvent, prepared) => {
              await authFixture.auth.writePreparedAccount(prepared);
              try {
                await options.provisionAuthAccount!(seed, {
                  installAuthSeed,
                  state,
                  auditEvent,
                });
              } catch (error) {
                await authFixture.auth.deleteAccount(prepared);
                throw error;
              }
            },
          }),
    });
    return Object.assign(created, { defaultSession: sessionsByPrincipalId.get(identity.id) });
  }

  const app = createApp();
  sessionsByPrincipalId.set(principal.id, await signInToControllerApp(app, authFixture));
  app.defaultSession = sessionsByPrincipalId.get(principal.id);

  return {
    app,
    session: app.defaultSession,
    authFixture,
    auditSink,
    computeCalls,
    createApp,
    async createAuthPrincipal(name: string) {
      const email = `${name}-${randomUUID()}@example.com`;
      const password = `generated-password-${randomUUID()}`;
      const account = await authFixture.auth.createAccount({
        email,
        password,
        name,
      });
      const seed = authFixture.auth.principalSeed(account, { grant: "none" });
      sessionsByPrincipalId.set(
        seed.principal.id,
        await signInToControllerApp(app, { email, password }),
      );
      return {
        principal: seed.principal,
        session: sessionsByPrincipalId.get(seed.principal.id),
      };
    },
    get iamDriver() {
      return iamDriver;
    },
    get computeDriver() {
      return computeDriver;
    },
    get configurationDriver() {
      return configurationDriver;
    },
    installationId,
    principal,
    state,
    get platformState() {
      return platformState;
    },
    installAuthSeed,
    get controller() {
      return controller;
    },
  };
}

export async function injectedRequest(
  app: ControllerApp & Partial<SessionApp>,
  method: string,
  pathname: string,
  options: InjectedRequestOptions = {},
) {
  const headers: Record<string, string> = {
    ...(options.identity === false
      ? {}
      : authenticatedHeaders(options.session ?? app.defaultSession)),
    ...options.headers,
  };
  const hasBody = Object.hasOwn(options, "body");
  const hasRawBody = Object.hasOwn(options, "rawBody");
  if (hasBody || hasRawBody) {
    headers["content-type"] ??= "application/json";
  }
  let payload: RequestInit["body"];
  if (hasRawBody) {
    payload = options.rawBody;
  } else if (hasBody) {
    payload = JSON.stringify(options.body);
  }
  const response = await app.fetch(
    new Request(`https://console.oce.localhost${pathname}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    }),
  );
  if (response.status === 204) {
    return { status: response.status, headers: response.headers };
  }
  const body: { meta?: { requestId?: string }; data?: unknown } = await response.json();
  assert.match(body.meta?.requestId ?? "", identifier("req"));
  return { status: response.status, headers: response.headers, body, data: body.data };
}
