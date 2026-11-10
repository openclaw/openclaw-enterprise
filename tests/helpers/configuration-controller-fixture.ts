import assert from "node:assert/strict";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp, type ControllerApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink, type AuditSink } from "../../packages/audit/src/index.ts";
import type {
  ComputeDriver,
  Configuration,
  ConfigurationDriver,
  ConfigurationReference,
  NamespaceResponse,
  Role,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "./auth-session.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";

// The integration backend returns undefined when a Configuration is absent.
type FixtureConfigurationDriver = Omit<ConfigurationDriver, "read"> & {
  read(reference: ConfigurationReference): Promise<Configuration | undefined>;
};

type Session = Awaited<ReturnType<typeof signInToControllerApp>>;
type FixtureApp = ControllerApp & { defaultSession?: Session };

type FixtureOptions = {
  permissions?: Role["permissions"];
  configurationDriver: FixtureConfigurationDriver | null;
  computeDriver?: ComputeDriver;
  computeImplementation?: string;
  auditSink?: AuditSink;
};

type RequestOptions = {
  body?: unknown;
  authorization?: boolean;
  session?: Session | string;
};

// Building a controller app and signing in to it cost more than most cases, so the cases share
// one administrator and one session, and one app per Driver shape: with or without a Compute
// Driver and a Configuration Driver. Cases run one at a time. Each gets a new Namespace and its
// own Drivers, audit sink and IAM grants: the app's Drivers and sink forward to the running
// case's. A forwarding Driver keeps one identity, because OCC rechecks it on every selection,
// so a case Driver's own id and implementation never reach OCC.
const running: {
  configurationDriver?: FixtureConfigurationDriver | null;
  computeDriver?: ComputeDriver;
  auditSink?: AuditSink;
} = {};
const apps = new Map<string, ReturnType<typeof sharedApp>>();
let administrator: ReturnType<typeof createTestAuthPrincipal> | undefined;
let session: Session | undefined;

function forwarder<Identity extends object, Delegate extends object>(
  identity: Identity,
  target: () => Delegate | null | undefined,
): Identity & Delegate {
  // Each case installs its delegates before use. A Driver proxy exists only for a shape with
  // that Driver, and the proxy exposes its delegate's members alongside the pinned identity.
  const getTarget = target as () => Delegate;
  return new Proxy(identity, {
    get(pinned, key): unknown {
      if (Object.hasOwn(pinned, key)) {
        return Reflect.get(pinned, key);
      }
      const value: unknown = Reflect.get(getTarget(), key);
      return typeof value === "function" ? value.bind(getTarget()) : value;
    },
    has: (pinned, key) => Object.hasOwn(pinned, key) || key in getTarget(),
  }) as Identity & Delegate;
}

async function sharedApp(
  withCompute: boolean,
  withConfiguration: boolean,
  computeImplementation: string,
) {
  const authFixture = await (administrator ??= createTestAuthPrincipal({
    name: "Configuration Integration Administrator",
  }));
  const principal = authFixture.seed.principal;
  const identities: NativeIAMState["identities"][number][] = [];
  const roles: NativeIAMState["roles"][number][] = [];
  const bindings: NativeIAMState["bindings"][number][] = [];
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities,
      groups: [],
      memberships: [],
      roles,
      bindings,
      restrictions: [],
    }),
  });
  const auditSink = forwarder({}, () => running.auditSink);
  let controller: OpenClawController | undefined;
  const app: FixtureApp = createControllerApp({
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
    iamDriver: iam,
    secretDriver: createTestSecretDriver(),
    ...(withConfiguration
      ? {
          // Preserve the test Driver's absent-row result through the controller's Driver interface.
          configurationDriver: forwarder(
            {
              id: "configuration-integration",
              capability: "configuration",
              implementation: "integration-memory-substrate",
            },
            () => running.configurationDriver,
          ) as ConfigurationDriver,
        }
      : {}),
    ...(withCompute
      ? {
          computeDriver: forwarder(
            {
              id: "compute-configuration-integration",
              capability: "compute",
              implementation: computeImplementation,
            },
            () => running.computeDriver,
          ),
        }
      : {}),
    resolveHarness: resolveApprovedDevelopmentHarness,
    auditSink,
    development: {
      enabled: true,
      browserOrigin: "https://console.oce.localhost",
      installationId: authFixture.installationId,
    },
    auth: authFixture.auth,
  });
  // Each case starts from the seeded administrator role's grants, or the permissions it names.
  const grant = (permissions: Role["permissions"] = authFixture.seed.roles[0]!.permissions) => {
    identities.splice(0, Infinity, principal);
    roles.splice(0, Infinity, { id: "role-configuration-integration", permissions });
    bindings.splice(0, Infinity, {
      id: "binding-configuration-integration",
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-configuration-integration",
    });
  };
  grant();
  session ??= await signInToControllerApp(app, authFixture);
  app.defaultSession = session;
  const installed = await request(app, "POST", "/installation/bootstrap", {
    body: { name: "Configuration integration" },
  });
  assert.equal(installed.status, 201);
  return { app, principal, identities, roles, bindings, controller, grant };
}

let namespaces = 0;

export async function createConfigurationControllerFixture({
  permissions,
  configurationDriver,
  computeDriver,
  // The Compute identity OCC sees. OCC applies the bundled Kubernetes Compute's channel binding
  // rule only for its implementations (finding 2319).
  computeImplementation = "integration-compute-substrate",
  auditSink = new InMemoryAuditSink(),
}: FixtureOptions) {
  Object.assign(running, { configurationDriver, computeDriver, auditSink });
  const shape = `${computeDriver !== undefined}/${configurationDriver !== null}/${computeImplementation}`;
  let app = apps.get(shape);
  if (app === undefined) {
    app = sharedApp(
      computeDriver !== undefined,
      configurationDriver !== null,
      computeImplementation,
    );
    apps.set(shape, app);
  }
  const { grant, ...context } = await app;
  grant(permissions);
  namespaces += 1;
  const namespace = await request(context.app, "POST", "/namespaces", {
    body: { name: `Configuration tenant ${namespaces}` },
  });
  assert.equal(namespace.status, 201);
  // The successful Namespace creation route wraps the Namespace response in data.
  const { data } = namespace.body as NamespaceResponse;
  return {
    ...context,
    auditSink,
    namespace: data,
    collection: `/namespaces/${data.id}/configurations`,
    presets: `/namespaces/${data.id}/presets`,
  };
}

export async function request(
  app: FixtureApp,
  method: string,
  pathname: string,
  { body, authorization = true, session = app.defaultSession }: RequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = authorization ? authenticatedHeaders(session) : {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`https://console.oce.localhost${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    status: response.status,
    body: response.status === 204 ? undefined : await response.json(),
  };
}
