# Feature Spec: SecretDriver storage and delivery: storage api and binding

[Spec overview](../14-secret-driver.md). Original record; decisions and status are preserved.

### Storage, owner, and bootstrap

OCC owns each Secret's stable ID, name, Namespace ID, selected driver identity, and opaque backend reference. Names are unique within the Namespace, parallel to existing ServiceAccount names. Secret metadata and backend identity do not contain `agentId`, do not require Agent existence, and do not create a foreign key to Agents. Each Secret holds one nonempty UTF-8 value without NUL; only that value is mutable. IAM grants cannot override the Namespace boundary or convert Namespace membership into Secret consumption.

Reuse the [Configuration ownership pattern](../../../packages/occ/src/state/postgres-schema.ts): PostgreSQL owns safe metadata, while the driver stores secret bytes. Public metadata reads use OCC state, not a second driver metadata authority, and do not assert backend readiness. Values must not enter OCC PostgreSQL, operation/audit payloads, revisions, ConfigMaps, public responses, platform logs, or containers without an admitted binding for that Secret. Audit only allowlisted identities, actions, and outcomes; regex redaction is insufficient.

The operator establishes Kubernetes access, tenant-local API RBAC, at-rest encryption, safe backups, and metadata-only Kubernetes auditing for Secret operations. An authorized owner or upstream issuer supplies material through the protected API; SecretDriver stores it but does not mint credentials. OCC verifies the existing Namespace's ready Compute-owned placement, not an Agent record. Kubernetes credentials remain installation bootstrap inputs, outside the store they enable.

Bootstrap order is: ready Namespace -> create Namespace-owned Secret -> create or update a Configuration binding -> create or update an Agent assignment -> deploy. A Secret may exist before any Agent in the Namespace. Neither secret storage nor Agent identity depends on a running gateway; the driver does not create another namespace, Agent, grant, broker, compatibility mode, or provisioning phase.

The API-side KubernetesSecretDriver creates an ordinary **mutable** Opaque Kubernetes Secret with a Namespace-derived, non-reused name and fixed `value` key. OCC records its UID/name/key; the driver checks exact Namespace/Secret ownership for writes, binding validation, delivery, and deletion. Update preserves object identity and unrelated metadata, uses Kubernetes concurrency preconditions, and surfaces conflicts. Missing or foreign objects are not silently recreated or adopted; callers cannot choose raw Kubernetes namespace/name selectors. Existing bootstrap/ServiceAccount Secrets retain their owners.

### API and per-use binding

Add Namespace-scoped Secret create/read/update/delete through the existing resource API. Create accepts `{ name, value }`; read and write responses contain only `{ id, namespaceId, name, ref }`. `ref` retains the existing resource-reference shape `{ kind: "secret", namespaceId, id }`. Update accepts `{ value }` for an existing Secret ID and returns the same reference. Reject oversize values; use protected input, never command-line literals or value-bearing errors.

| Method | Route                                        | Operation      | Result                |
| ------ | -------------------------------------------- | -------------- | --------------------- |
| POST   | `/namespaces/:namespaceId/secrets`           | `createSecret` | 201 metadata only     |
| GET    | `/namespaces/:namespaceId/secrets/:secretId` | `getSecret`    | 200 metadata only     |
| PATCH  | `/namespaces/:namespaceId/secrets/:secretId` | `updateSecret` | 200 same metadata/ref |
| DELETE | `/namespaces/:namespaceId/secrets/:secretId` | `deleteSecret` | 204                   |

The driver implements storage `create`, `update`, `delete`, and validated env-projection resolution. It returns no plaintext to ordinary OCC/Compute consumers. Bundled Installation configuration selects KubernetesSecretDriver under `drivers.secret`; unavailable selection or persisted driver-identity mismatch fails closed. No request can select its own driver or fall back to another source.

This proposed SDK fragment stores the Secret before any Agent exists. Unchanged provider endpoint/model fields are omitted:

```ts
const secret = await occ.secrets.create({ namespaceId, name: "model-key", value });
const configuration = {
  secretBindings: {
    OPENAI_API_KEY: { source: secret.ref }, // defaults to delivery: { type: "env" }
  },
  values: {
    secrets: {
      providers: {
        model: { source: "env", allowlist: ["OPENAI_API_KEY"] },
      },
    },
    models: {
      providers: {
        openai: {
          apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
        },
      },
    },
  },
};
// Later: update this Secret's value; keep secret.ref and the binding unchanged.
```

`Configuration.secretBindings` maps destination env names to `{ source, delivery?: { type: "env" } }`, separately from native `Configuration.values`. All bound Secrets must belong to the same Namespace as the Configuration and consuming Agent. A Configuration create or update whose resulting Configuration contains bindings requires the caller to have the existing Configuration mutation permission and `operate` on every selected Secret, including retained bindings when PATCH omits `secretBindings`. Creating or updating an Agent assignment to a bound Configuration requires the caller to have the existing Agent mutation permission and `operate` on each exact Secret. Unbound Configurations retain their existing semantics. Admission freezes normalized bindings and selected driver identity in AgentRevision; it does not snapshot backend locators or pin secret values. OCC metadata remains the sole authority for each immutable Namespace/backend identity.

Source identifies the supplying authority; delivery specifies consumption. Only typed Secret references and env delivery are implemented here. A future CredentialGateway can supply its own typed reference and substitution mode without routing every opaque reference through SecretDriver. Its schema/executor stays deferred. Unknown source kinds or delivery modes are rejected, never downgraded to plaintext env.

The accepted OpenClaw [v2026.5.28 SecretRef](https://github.com/openclaw/openclaw/blob/v2026.5.28/src/config/types.secrets.ts) remains `{ source, provider, id }`, supporting `env`, `file`, and `exec`. The example uses env; preserve other supported native refs without claiming this driver provisions their files/executables. Do not add a native `kubernetes` source or resolve arbitrary configuration text in OCC.

