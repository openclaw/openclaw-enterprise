/** The alpha Kubernetes interface. These schemas do not replace OCC admission. */
export const OPERATOR_GROUP = "enterprise.openclaw.ai";
export const OPERATOR_VERSION = "v1alpha1";

type Schema = Readonly<Record<string, unknown>>;

const name: Schema = { type: "string", minLength: 1, maxLength: 253 };
const opaqueId: Schema = { type: "string", minLength: 1, maxLength: 256 };
const keyRef: Schema = {
  type: "object",
  required: ["name", "key"],
  properties: { name, key: name },
};
const nativeDocument: Schema = {
  type: "object",
  "x-kubernetes-preserve-unknown-fields": true,
};
const immutable: Schema = {
  "x-kubernetes-validations": [{ rule: "self == oldSelf", message: "Reference is immutable" }],
};
const reference: Schema = { ...name, ...immutable };
const retention = (values: readonly string[]): Schema => ({
  type: "string",
  enum: values,
  default: "Retain",
});
const connection: Schema = {
  type: "object",
  required: ["endpoint", "installationId", "serviceKeyRef", "namespaceScope"],
  properties: {
    endpoint: { type: "string", pattern: "^https://", ...immutable },
    address: { type: "string", maxLength: 45, pattern: "^[0-9a-fA-F:.]+$" },
    installationId: { ...opaqueId, ...immutable },
    serviceKeyRef: keyRef,
    caSecretKeyRef: keyRef,
    namespaceScope: {
      type: "object",
      required: ["existingIds", "allowCreate"],
      properties: {
        existingIds: { type: "array", items: opaqueId, maxItems: 1000 },
        allowCreate: { type: "boolean", default: false },
      },
    },
    approvedSecretKeys: { type: "array", items: keyRef, maxItems: 1000 },
  },
};
const namespace: Schema = {
  type: "object",
  required: ["connectionRef"],
  properties: {
    connectionRef: reference,
    existingId: { ...opaqueId, ...immutable },
    create: {
      type: "object",
      required: ["name"],
      properties: { name },
      ...immutable,
    },
    deletionPolicy: retention(["Retain", "DeleteEmpty"]),
  },
  "x-kubernetes-validations": [
    { rule: "has(self.existingId) != has(self.create)", message: "Select existingId or create" },
    {
      rule: "has(self.existingId) == has(oldSelf.existingId)",
      message: "Namespace ownership mode is immutable",
    },
    {
      rule: "!has(self.existingId) || self.deletionPolicy == 'Retain'",
      message: "An existing Namespace must be retained",
    },
  ],
};
const secret: Schema = {
  type: "object",
  required: ["namespaceRef"],
  properties: {
    namespaceRef: reference,
    existingId: { ...opaqueId, ...immutable },
    sourceSecretKeyRef: { ...keyRef, ...immutable },
    deletionPolicy: retention(["Retain", "Delete"]),
  },
  "x-kubernetes-validations": [
    {
      rule: "has(self.existingId) != has(self.sourceSecretKeyRef)",
      message: "Select existingId or sourceSecretKeyRef",
    },
    {
      rule: "has(self.existingId) == has(oldSelf.existingId)",
      message: "Secret ownership mode is immutable",
    },
    {
      rule: "!has(self.existingId) || self.deletionPolicy == 'Retain'",
      message: "An existing Secret must be retained",
    },
  ],
};
const agent: Schema = {
  type: "object",
  required: ["namespaceRef", "executionMode", "configuration", "harnessAuth"],
  "x-kubernetes-validations": [
    { rule: "has(self.adopt) == has(oldSelf.adopt)", message: "Agent adoption mode is immutable" },
  ],
  properties: {
    namespaceRef: reference,
    executionMode: { type: "string", enum: ["dedicated"] },
    desiredState: { type: "string", enum: ["running", "stopped"], default: "running" },
    nativeAdmin: { type: "boolean", default: false },
    configuration: {
      type: "object",
      required: ["values"],
      properties: {
        values: nativeDocument,
        secretBindings: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["secretRef", "delivery"],
            properties: {
              secretRef: name,
              delivery: {
                type: "object",
                required: ["type"],
                properties: { type: { type: "string", enum: ["env"] } },
              },
            },
          },
        },
      },
    },
    harnessAuth: {
      type: "object",
      required: ["method"],
      properties: {
        method: { type: "string", enum: ["credential_source", "api_key", "codex_pat"] },
        sourceId: opaqueId,
        secretRef: name,
      },
      "x-kubernetes-validations": [
        {
          rule: "self.method == 'credential_source' ? (has(self.sourceId) && !has(self.secretRef)) : (has(self.secretRef) && !has(self.sourceId))",
          message: "Select a credential source ID or a Secret reference for the method",
        },
      ],
    },
    adopt: {
      type: "object",
      required: [
        "agentId",
        "configurationId",
        "configurationGeneration",
        "fingerprint",
        "managementVersion",
      ],
      properties: {
        agentId: opaqueId,
        configurationId: opaqueId,
        configurationGeneration: { type: "integer", format: "int64", minimum: 1 },
        activeRevisionId: opaqueId,
        fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        managementVersion: { type: "integer", format: "int64", minimum: 0 },
      },
      ...immutable,
    },
    retryNonce: { type: "string", maxLength: 128 },
    deletionPolicy: retention(["Retain", "Delete"]),
  },
};

const conditions: Schema = {
  type: "array",
  "x-kubernetes-list-type": "map",
  "x-kubernetes-list-map-keys": ["type"],
  items: {
    type: "object",
    required: ["type", "status", "reason", "message", "lastTransitionTime", "observedGeneration"],
    properties: {
      type: name,
      status: { type: "string", enum: ["True", "False", "Unknown"] },
      reason: name,
      message: { type: "string", maxLength: 1024 },
      lastTransitionTime: { type: "string", format: "date-time" },
      observedGeneration: { type: "integer", format: "int64", minimum: 0 },
    },
  },
};

const definitions = [
  ["OCEConnection", "oceconnection", "oceconnections", connection],
  ["OCENamespace", "ocenamespace", "ocenamespaces", namespace],
  ["OCESecret", "ocesecret", "ocesecrets", secret],
  ["OCEAgent", "oceagent", "oceagents", agent],
] as const;

export function operatorCustomResourceDefinitions(): readonly Readonly<Record<string, unknown>>[] {
  return definitions.map(([kind, singular, plural, spec]) => ({
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinition",
    metadata: { name: `${plural}.${OPERATOR_GROUP}` },
    spec: {
      group: OPERATOR_GROUP,
      scope: "Namespaced",
      names: { kind, singular, plural },
      versions: [
        {
          name: OPERATOR_VERSION,
          served: true,
          storage: true,
          subresources: { status: {} },
          additionalPrinterColumns: [
            {
              name: "Ready",
              type: "string",
              jsonPath: '.status.conditions[?(@.type=="Ready")].status',
            },
            { name: "Revision", type: "string", jsonPath: ".status.activeRevisionId" },
            { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
          ],
          schema: {
            openAPIV3Schema: {
              type: "object",
              required: ["spec"],
              properties: {
                apiVersion: { type: "string" },
                kind: { type: "string" },
                metadata: { type: "object" },
                spec,
                status: {
                  type: "object",
                  properties: {
                    observedGeneration: { type: "integer", format: "int64", minimum: 0 },
                    namespaceId: opaqueId,
                    secretId: opaqueId,
                    agentId: opaqueId,
                    configurationId: opaqueId,
                    activeRevisionId: opaqueId,
                    requestedRevisionId: opaqueId,
                    operationId: opaqueId,
                    managementVersion: { type: "integer", format: "int64", minimum: 1 },
                    lastObservedTime: { type: "string", format: "date-time" },
                    conditions,
                  },
                },
              },
            },
          },
        },
      ],
    },
  }));
}
