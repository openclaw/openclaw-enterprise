import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";

// Bootstrap allocates the first Namespace ID for the initial default Namespace, so the
// first Namespace a test creates is tenant A.
export const tenantANamespaceId = "ns_00000000-0000-4000-8000-000000000002";

const tenantAReaderPermissions = [
  { action: "read", resourceKind: "namespace" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];

/**
 * An in-memory development controller app with two signed-in people under Native IAM: an
 * installation administrator holding `administratorPermissions`, and a reader of tenant A
 * only. IDs are sequential so tests can name tenant A before it exists.
 *
 * `createApp(principal, overrides, factory)` builds another app over the same controller
 * with `principal`'s session as `app.defaultSession`; `appOptions(overrides)` maps a test's
 * overrides to extra app options. The returned `app` was built with `options` as overrides;
 * the fixture itself also reads `options.identities` (the provisioned identities, default
 * both people; bindings of anyone left out are dropped) and `options.restrictions`.
 */
export async function createTenantReaderFixture({
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
}) {
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
  const state = {
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
    bindings: [
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
    ].filter(({ subjectId }) => identityIds.has(subjectId)),
    restrictions: options.restrictions ?? [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    { id: `iam-${label}` },
  );
  const auditSink = new InMemoryAuditSink();
  const configurationDriver = createTestConfigurationDriver({ id: `configuration-${label}` });
  const sessions = new Map();
  let controller;
  let sequence = 0;
  let configurationSequence = 0;

  function createApp(principal = administrator, overrides = {}, factory = createControllerApp) {
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
                  const prefix = {
                    namespace: "ns",
                    agent: "agt",
                    agent_revision: "rev",
                    secret: "sec",
                  }[kind];
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
        installationId,
        ...overrides.development,
      },
      auth: adminAuth.auth,
      ...appOptions(overrides),
    });
    app.defaultSession = sessions.get(principal.id);
    return app;
  }

  const app = createApp(administrator, options);
  sessions.set(administrator.id, await signInToControllerApp(app, adminAuth));
  sessions.set(
    tenantAReader.id,
    await signInToControllerApp(app, { email: readerEmail, password: readerPassword }),
  );
  app.defaultSession = sessions.get(administrator.id);

  return {
    app,
    administrator,
    tenantAReader,
    auditSink,
    createApp,
    auth: adminAuth.auth,
    iamDriver,
    state,
    get controller() {
      return controller;
    },
  };
}

/**
 * Sends one request to a fixture app (`app.fetch`) as `options.session`, default the app's
 * own session; `identity: false` sends none. The URL is `pathname` on `options.origin`,
 * default `http://127.0.0.1`. A `body` (JSON-encoded unless a string) makes the default
 * method POST; a `headers` entry set to null removes that header. Every answer must be the
 * documented JSON envelope: a request ID (also sent as `x-request-id`), then `data` or a
 * string error code and message. Returns `{ response, payload }`.
 */
export async function tenantRequest(app, pathname, options = {}) {
  const headers = new Headers(
    options.identity === false ? {} : authenticatedHeaders(options.session ?? app.defaultSession),
  );
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
    new Request(new URL(pathname, options.origin ?? "http://127.0.0.1"), {
      method: options.method ?? (hasBody ? "POST" : "GET"),
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
  const contentType = response.headers.get("content-type");
  assert.match(contentType ?? "", /^application\/json\b/i);
  const payload = await response.json();
  assert.match(
    payload.meta?.requestId ?? "",
    /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(response.headers.get("x-request-id"), payload.meta.requestId);

  if (response.ok) {
    assert.ok(Object.hasOwn(payload, "data"));
  } else {
    assert.equal(typeof payload.error?.code, "string");
    assert.equal(typeof payload.error?.message, "string");
  }

  return { response, payload };
}
