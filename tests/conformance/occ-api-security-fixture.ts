import assert from "node:assert/strict";
import type { TSchema, Static } from "typebox";
import { Check } from "typebox/value";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentSchema,
  ConfigurationSchema,
  InstallationSchema,
  NamespaceSchema,
  NamespaceListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { AuditEvent, Permission } from "../../packages/contracts/src/index.ts";
import { BOOTSTRAP_DEFAULT_NAMESPACE_NAME } from "../../packages/occ/src/index.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import {
  createTenantReaderFixture,
  tenantRequest as request,
} from "../helpers/tenant-reader-app.ts";

export type SecurityFixture = Awaited<ReturnType<typeof createFixture>>;
type FixtureOptions = NonNullable<Parameters<typeof createTenantReaderFixture>[0]["options"]>;
type AppOverrides = Pick<ControllerAppOptions, "maxBodyBytes" | "publicOrigin">;
type NamespaceTarget = { readonly id: string };
type AgentTarget = { readonly id: string };

export const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
export const bootstrapDefaultNamespaceId = "ns_00000000-0000-4000-8000-000000000001";

const permissions: readonly Permission[] = [
  { action: "administer", resourceKind: "installation" },
  { action: "read", resourceKind: "installation" },
  { action: "create", resourceKind: "namespace" },
  { action: "read", resourceKind: "namespace" },
  { action: "delete", resourceKind: "namespace" },
  { action: "create", resourceKind: "configuration" },
  { action: "read", resourceKind: "configuration" },
  { action: "update", resourceKind: "configuration" },
  { action: "delete", resourceKind: "configuration" },
  { action: "create", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "update", resourceKind: "agent" },
  { action: "deploy", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
  { action: "administer", resourceKind: "agent" },
];

export function createFixture(options: FixtureOptions & AppOverrides = {}) {
  return createTenantReaderFixture<AppOverrides>({
    installationId,
    label: "security",
    administratorName: "Security Administrator",
    readerName: "Tenant A Reader",
    administratorPermissions: permissions,
    computeDriver: createReadyComputeDriver("compute-security"),
    recordOperations: true,
    appOptions: (overrides) => ({
      ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
      ...(overrides.publicOrigin === undefined ? {} : { publicOrigin: overrides.publicOrigin }),
    }),
    options,
  });
}

export async function bootstrap(fixture: SecurityFixture) {
  const result = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Security test installation" },
  });
  assert.equal(result.response.status, 201);
  const installation = responseData(InstallationSchema, result.payload);
  assert.equal(installation.id, installationId);
  return installation;
}

export async function bootstrappedDefaultNamespace(fixture: SecurityFixture) {
  const namespaces = await request(fixture.app, "/namespaces");
  assert.equal(namespaces.response.status, 200);
  const found = responseData(NamespaceListResponse.properties.data, namespaces.payload).find(
    (namespace) => namespace.name === BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  );
  assert.ok(found, "fresh bootstrap must create the default Namespace");
  assert.equal(found.id, bootstrapDefaultNamespaceId);
  assert.equal(found.status, "provisioning");
  return found;
}

export async function createNamespace(fixture: SecurityFixture, name: string) {
  const result = await request(fixture.app, "/namespaces", {
    body: { name },
  });
  assert.equal(result.response.status, 201);
  return responseData(NamespaceSchema, result.payload);
}

export async function createConfiguration(
  fixture: SecurityFixture,
  namespace: NamespaceTarget,
  values: Record<string, unknown> = {},
) {
  const result = await request(fixture.app, `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values },
  });
  assert.equal(result.response.status, 201);
  const id = field(field(result.payload, "data"), "id");
  assert.ok(Check(ConfigurationSchema.properties.id, id));
  return { id };
}

export async function createAgent(
  fixture: SecurityFixture,
  namespace: NamespaceTarget,
  name: string,
) {
  const configuration = await createConfiguration(fixture, namespace);
  const result = await request(fixture.app, `/namespaces/${namespace.id}/agents`, {
    body: { name, configurationId: configuration.id },
  });
  assert.equal(result.response.status, 201);
  return responseData(AgentSchema, result.payload);
}

export async function expectProvisioningDeployRefusal(
  fixture: SecurityFixture,
  namespace: NamespaceTarget,
  agent: AgentTarget,
) {
  const result = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
    { method: "POST" },
  );
  assert.equal(result.response.status, 409);
  assert.equal(responseError(result.payload).code, "NAMESPACE_NOT_READY");
}

export function responseData<Schema extends TSchema>(
  schema: Schema,
  payload: unknown,
): Static<Schema> {
  assert.ok(typeof payload === "object" && payload !== null && "data" in payload);
  const data = payload.data;
  assert.ok(Check(schema, data), "expected response data to match the operation schema");
  return data;
}

export function responseError(payload: unknown) {
  assert.ok(Check(ErrorResponse, payload), "expected the OCC API error envelope");
  return payload.error;
}

export function field<Key extends string>(value: unknown, key: Key): unknown {
  assert.ok(hasField(value, key), `expected field ${key}`);
  return value[key];
}

function hasField<Key extends string>(value: unknown, key: Key): value is Record<Key, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

export function restrictionIds(event: AuditEvent | undefined): unknown {
  return field(event?.details?.iamEvidence, "restrictionIds");
}
