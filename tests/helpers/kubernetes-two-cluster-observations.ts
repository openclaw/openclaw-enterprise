import assert from "node:assert/strict";

import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { asRecord } from "../../packages/utils/src/objects.ts";

const text = Type.String();
const nonempty = Type.String({ minLength: 1 });
const stringMap = Type.Record(Type.String(), text);
const fields = Type.Record(Type.String(), Type.Unknown());
const id = Type.Object({ id: nonempty });
const plane = Type.Object({
  kubeconfigPath: nonempty,
  kubernetesContext: nonempty,
  release: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
  systemNamespace: nonempty,
});
const metadata = Type.Object({
  name: nonempty,
  uid: nonempty,
  labels: Type.Optional(stringMap),
  deletionTimestamp: Type.Optional(text),
});
const error = Type.Object({ code: Type.String({ pattern: "^[A-Z0-9_]+$", maxLength: 64 }) });

// Only the fields this scenario actually observes are required. In particular, an
// unrelated Kubernetes or API field must not make an ownership check fail.
export const observation = {
  configuration: Type.Object({
    serviceKeyFile: nonempty,
    dockerContext: nonempty,
    agentConfiguration: fields,
    control: plane,
    execution: plane,
  }),
  serviceKey: Type.Object({ data: Type.Object({ key: nonempty }) }),
  namespace: Type.Object({ metadata }),
  namespaceList: Type.Object({ items: Type.Array(Type.Object({ metadata })) }),
  dockerContext: Type.Object({ Endpoints: Type.Object({ docker: Type.Object({ Host: text }) }) }),
  dockerNode: Type.Object({
    Id: nonempty,
    Config: Type.Object({ Labels: stringMap }),
    State: Type.Object({ Running: Type.Boolean() }),
  }),
  id,
  namespaceStatus: Type.Object({ status: text }),
  agent: Type.Object({ id: nonempty, servicePrincipalId: nonempty }),
  agents: Type.Array(Type.Object({ id: nonempty, status: text })),
  presets: Type.Array(id),
  secret: Type.Object({ id: nonempty, ref: fields }),
  deployment: Type.Object({ status: text, error: Type.Optional(Type.Union([error, Type.Null()])) }),
  workspace: Type.Object({ content: text }),
  runtime: Type.Object({ pods: Type.Array(Type.Object({ role: text, cluster: text })) }),
  logs: Type.Object({
    stream: Type.Union([Type.Object({ pod: text }), Type.Null()]),
    records: Type.Array(Type.Object({ type: text, contentClass: Type.Optional(text) })),
    cursor: Type.Union([text, Type.Null()]),
  }),
  pod: Type.Object({
    metadata,
    spec: Type.Object({
      containers: Type.Array(
        Type.Object({
          name: text,
          env: Type.Optional(
            Type.Array(
              Type.Object({
                name: text,
                valueFrom: Type.Optional(
                  Type.Object({
                    secretKeyRef: Type.Optional(Type.Object({ name: nonempty, key: nonempty })),
                  }),
                ),
              }),
            ),
          ),
        }),
      ),
    }),
    status: Type.Optional(
      Type.Object({
        conditions: Type.Optional(Type.Array(Type.Object({ type: text, status: text }))),
      }),
    ),
  }),
  networkPolicy: Type.Object({
    metadata: Type.Object({ name: nonempty }),
    spec: Type.Object({ podSelector: Type.Object({ matchLabels: Type.Optional(stringMap) }) }),
  }),
  deliveredSecret: Type.Object({
    metadata: Type.Object({ labels: Type.Optional(stringMap) }),
    data: Type.Optional(stringMap),
  }),
  chatTurn: Type.Object({
    denied: Type.Number(),
    status: Type.Number(),
    content: Type.Optional(Type.Unknown()),
    errorCode: Type.Optional(Type.Unknown()),
  }),
};

export function observe<Schema extends TSchema>(schema: Schema, value: unknown, label: string) {
  assert.ok(Check(schema, value), `Invalid two-cluster observation: ${label}`);
  return value;
}

export function observeList<Schema extends TSchema>(
  schema: Schema,
  items: readonly unknown[] | undefined,
  label: string,
): Static<Schema>[] {
  assert.ok(items, `Missing two-cluster list: ${label}`);
  return items.map((item) => observe(schema, item, label));
}

export function observeFirst<Schema extends TSchema>(schema: Schema, json: string, label: string) {
  const values = parseObservationJson(json, label);
  assert.ok(Array.isArray(values), `Invalid two-cluster list: ${label}`);
  return observe(schema, values[0], label);
}

export function parseObservationJson(json: string, label: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    // Parser errors may quote the input, which can include key material.
    throw new Error(`Invalid JSON for two-cluster observation: ${label}`);
  }
}

export function diagnosticCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && /^[A-Z0-9_]+$/.test(value)
    ? value
    : undefined;
}

export function createTwoClusterApi(origin: URL, key: string) {
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "x-api-key": key,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) {
      return undefined;
    }
    const label = `${method} ${path}`;
    const envelope = asRecord(parseObservationJson(await response.text(), label));
    const code = diagnosticCode(asRecord(envelope?.error)?.code);
    assert.ok(response.ok, `${label}: ${response.status} ${code ?? "no error code"}`);
    assert.ok(envelope, `Invalid two-cluster response envelope: ${label}`);
    return envelope.data;
  }
  return {
    request,
    async observe<Schema extends TSchema>(
      schema: Schema,
      method: string,
      path: string,
      body?: unknown,
    ) {
      return observe(schema, await request(method, path, body), `${method} ${path}`);
    },
  };
}
