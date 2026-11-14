import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  createControllerApp,
  type ControllerApp,
  type ControllerAppOptions,
} from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { RequestId } from "../../packages/contracts/src/api/common.ts";
import type { Identity, Permission, ResourceKind } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.ts";

// Bootstrap allocates the first Namespace ID for the initial default Namespace, so the
// first Namespace a test creates is tenant A.
export const tenantANamespaceId = "ns_00000000-0000-4000-8000-000000000002";

const tenantAReaderPermissions: Permission[] = [
  { action: "read", resourceKind: "namespace" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];

const sequentialIdPrefixes: Partial<Record<ResourceKind, string>> = {
  namespace: "ns",
  agent: "agt",
  agent_revision: "rev",
  secret: "sec",
  preset: "pre",
  service_account: "sa",
};

type Session = Pick<Awaited<ReturnType<typeof signInToControllerApp>>, "cookie" | "origin">;

type MutableNativeIAMState = {
  -readonly [Key in keyof NativeIAMState]: Array<NativeIAMState[Key][number]>;
};

type FixtureOverrides = {
  development?: Partial<ControllerAppOptions["development"]>;
  identities?: MutableNativeIAMState["identities"];
  restrictions?: MutableNativeIAMState["restrictions"];
};

type TenantReaderFixtureOptions<Overrides extends object> = {
  installationId: string;
  label: string;
  administratorName: string;
  readerName: string;
  administratorPermissions: readonly Permission[];
  computeDriver: NonNullable<ControllerAppOptions["computeDriver"]>;
  secretDriver?: NonNullable<ControllerAppOptions["secretDriver"]>;
  recordOperations?: boolean;
  appOptions?: (overrides: FixtureOverrides & Partial<Overrides>) => Partial<ControllerAppOptions>;
  options?: FixtureOverrides & Partial<Overrides>;
};

type SessionApp<App extends object> = App & { defaultSession: Session | undefined };
export type TenantReaderApp = SessionApp<ControllerApp>;

type SessionIdentity = Pick<Identity, "id">;

/**
 * An in-memory development controller app with two signed-in people under Native IAM: an
 * installation administrator holding `administratorPermissions`, and a reader of tenant A
 * only. IDs are sequential so tests can name tenant A before it exists.
 *
 * `createApp(principal, overrides, factory)` builds another app over the same controller
 * with `principal`'s session as `app.defaultSession`, and `session(principal)` returns that
 * session for a request on an existing app; `appOptions(overrides)` maps a test's
 * overrides to extra app options. The returned `app` was built with `options` as overrides;
 * the fixture itself also reads `options.identities` (the provisioned identities, default
 * both people; bindings of anyone left out are dropped) and `options.restrictions`.
 */
export async function createTenantReaderFixture<Overrides extends object>({
  installationId,
  label,
  administratorName,
  readerName,
  administratorPermissions,
  computeDriver,
  secretDriver,
  recordOperations = false,
  appOptions = () => ({}),
  options = {},
}: TenantReaderFixtureOptions<Overrides>) {
  const adminAuth = await createTestAuthPrincipal({ installationId, name: administratorName });
  const administrator = adminAuth.seed.principal;
  const readerEmail = `${readerName.toLowerCase().replaceAll(" ", "-")}-${randomUUID()}@example.com`;
  const readerPassword = `generated-password-${randomUUID()}`;
  const readerAccount = await adminAuth.auth.createAccount({
    email: readerEmail,
    password: readerPassword,
    name: readerName,
  });
  const tenantAReader = adminAuth.auth.principalSeed(readerAccount, { grant: "none" }).principal;
  const identities = options.identities ?? [administrator, tenantAReader];
  const identityIds = new Set(identities.map(({ id }) => id));
  const bindings: MutableNativeIAMState["bindings"] = [
    {
      id: "binding-administrator",
      subjectKind: "identity",
      subjectId: administrator.id,
      roleId: "role-administrator",
    },
    {
      id: "binding-tenant-a-reader",
      namespaceId: tenantANamespaceId,
      subjectKind: "identity",
      subjectId: tenantAReader.id,
      roleId: "role-tenant-a-reader",
    },
  ];
  const state: MutableNativeIAMState = {
    identities,
    groups: [],
    memberships: [],
    roles: [
      { id: "role-administrator", permissions: [...administratorPermissions] },
      {
        id: "role-tenant-a-reader",
        namespaceId: tenantANamespaceId,
        permissions: tenantAReaderPermissions.map((permission) => ({ ...permission })),
      },
    ],
    bindings: bindings.filter(({ subjectId }) => identityIds.has(subjectId)),
    restrictions: options.restrictions ?? [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    { id: `iam-${label}` },
  );
  const auditSink = new InMemoryAuditSink();
  const configurationDriver = createTestConfigurationDriver({ id: `configuration-${label}` });
  const sessions = new Map<string, Session>();
  let controller: OpenClawController | undefined;
  let sequence = 0;
  let configurationSequence = 0;

  function createApp(
    principal?: SessionIdentity,
    overrides?: FixtureOverrides & Partial<Overrides>,
  ): TenantReaderApp;
  function createApp<App extends object>(
    principal: SessionIdentity | undefined,
    overrides: (FixtureOverrides & Partial<Overrides>) | undefined,
    factory: (options: ControllerAppOptions) => App,
  ): SessionApp<App>;
  function createApp(
    principal: SessionIdentity = administrator,
    overrides: FixtureOverrides & Partial<Overrides> = {},
    factory: (options: ControllerAppOptions) => object = createControllerApp,
  ) {
    const app = factory({
      ...(controller === undefined
        ? {
            createController(installation) {
              controller = new OpenClawController(installation, {
                state: new InMemoryPlatformState({ auditSink }),
                recordOperations,
                createId(kind) {
                  if (kind === "configuration") {
                    configurationSequence += 1;
                    return `cfg_10000000-0000-4000-8000-${String(configurationSequence).padStart(12, "0")}`;
                  }
                  sequence += 1;
                  const prefix = sequentialIdPrefixes[kind];
                  assert.ok(prefix, `No sequential fixture ID prefix for ${kind}`);
                  return `${prefix}_00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
                },
              });
              return controller;
            },
          }
        : { controller }),
      iamDriver,
      computeDriver,
      configurationDriver,
      ...(secretDriver === undefined ? {} : { secretDriver }),
      resolveHarness: resolveApprovedDevelopmentHarness,
      auditSink,
      development: {
        enabled: true,
        browserOrigin: "https://console.oce.localhost",
        installationId,
        ...overrides.development,
      },
      auth: adminAuth.auth,
      ...appOptions(overrides),
    });
    return Object.assign(app, { defaultSession: sessions.get(principal.id) });
  }

  const app = createApp(administrator, options);
  const administratorSession: Session = await signInToControllerApp(app, adminAuth);
  sessions.set(administrator.id, administratorSession);
  sessions.set(
    tenantAReader.id,
    await signInToControllerApp(app, { email: readerEmail, password: readerPassword }),
  );

  return {
    app: Object.assign(app, { defaultSession: administratorSession }),
    administrator,
    tenantAReader,
    auditSink,
    createApp,
    auth: adminAuth.auth,
    iamDriver,
    state,
    session: (principal: SessionIdentity) => sessions.get(principal.id),
    get controller() {
      return controller;
    },
  };
}

export type TenantRequestOptions = {
  body?: unknown;
  headers?: Record<string, string | null>;
  identity?: boolean;
  method?: string;
  origin?: string;
  session?: Session | string;
};

type RequestApp = ControllerApp & { defaultSession?: Session | undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

/**
 * Sends one request to a fixture app (`app.fetch`) as `options.session`, default the app's
 * own session; `identity: false` sends none. The URL is `pathname` on `options.origin`,
 * default `https://console.oce.localhost`. A `body` (JSON-encoded unless a string) makes the default
 * method POST; a `headers` entry set to null removes that header. Every answer must be the
 * documented JSON envelope: a request ID (also sent as `x-request-id`), then `data` or a
 * string error code and message. Returns `{ response, payload }`.
 */
export async function tenantRequest(
  app: RequestApp,
  pathname: string,
  options: TenantRequestOptions = {},
) {
  const session = options.session ?? app.defaultSession;
  const headers = new Headers(options.identity === false ? {} : authenticatedHeaders(session));
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  const hasBody = Object.hasOwn(options, "body");
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const body = hasBody
    ? typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body)
    : undefined;
  const response = await app.fetch(
    new Request(new URL(pathname, options.origin ?? "https://console.oce.localhost"), {
      method: options.method ?? (hasBody ? "POST" : "GET"),
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
  const contentType = response.headers.get("content-type");
  assert.match(contentType ?? "", /^application\/json\b/i);
  const payload = record(await response.json());
  const requestId = record(payload.meta).requestId;
  assert.ok(Check(RequestId, requestId), "Expected a request ID in the response metadata");
  assert.equal(response.headers.get("x-request-id"), requestId);

  if (response.ok) {
    assert.ok(Object.hasOwn(payload, "data"));
  } else {
    const error = record(payload.error);
    assert.equal(typeof error.code, "string");
    assert.equal(typeof error.message, "string");
  }

  return { response, payload };
}
