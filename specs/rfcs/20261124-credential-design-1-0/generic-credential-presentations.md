---
rfc: index.md
---

# Admit generic credential presentations

Current managed model Source presets and Plugin slots use Bearer authorization. OCE already sends Anthropic model keys in `x-api-key` outside managed Source delivery, although [Anthropic also accepts Bearer](https://platform.claude.com/docs/en/manage-claude/authentication). The model binding contract names `x-api-key`, but no production Source preset emits it, and native OpenShell delivery refuses non-Bearer model and Plugin bindings. Other API clients can use an [`api-key` header for Azure OpenAI](https://learn.microsoft.com/en-us/azure/foundry/openai/latest) or [HTTP Basic for Twilio](https://www.twilio.com/docs/usage/requests-to-twilio). A managed binding cannot use those formats unless it can describe and enforce their placement.

This proposed amendment extends the [Installation credential ownership amendment](installation-credential-ownership.md#prepare-an-agent-revision). A reviewed consumer declares where and how its credential may appear in an outbound request. TokenService keeps custody of the Source. Existing Bearer flows do not require this extension.

## Decision

A reviewed Plugin slot, model profile, or other supported consumer declares a credential presentation. OCC admits it and saves it as `DeploymentCredentialBinding.projection.presentation` in the Agent revision. This is the shared representation at the OCC-to-Driver boundary.

During deployment, the OCC Worker passes that binding to `CredentialProxyDriver.configureDeployment()` in `input.bindings[].binding`. It also passes the injection policies for the binding. The Driver must understand the admitted presentation, combine it with the matching policy's allowed requests, and install the corresponding rule in its Proxy implementation. If it cannot enforce the declaration, it refuses the binding. The Sandbox enforces routing and containment. TokenService still owns the credential and its lifecycle.

Replace the Plugin's fixed `bearer` projection and the model's `bearer | x-api-key` projection with one shared representation:

```ts
type CredentialValueFormat =
  { readonly kind: "raw" } | { readonly kind: "prefix"; readonly prefix: string };

type CredentialPresentation =
  | { readonly kind: "header"; readonly name: string; readonly value: CredentialValueFormat }
  | { readonly kind: "basic" }
  | { readonly kind: "query"; readonly parameter: string; readonly value: CredentialValueFormat }
  | { readonly kind: "path"; readonly template: string }
  | { readonly kind: "path_subtree"; readonly template: string };
```

For example, OCC records this model projection and passes it unchanged in the binding to CredentialProxyDriver:

```ts
const projection = {
  environment: "OPENAI_API_KEY",
  presentation: {
    kind: "header",
    name: "authorization",
    value: { kind: "prefix", prefix: "Bearer " },
  },
};
```

The presentation specifies the credential's request location and format. The separate injection policy specifies which requests may receive it; the environment name specifies where the Harness receives its placeholder.

For a header or query parameter, `raw` permits only the placeholder as the value; `prefix` permits only a nonempty reviewed literal prefix followed by the placeholder. Admission rejects an empty prefix; use `raw` for that value. Store header names in lowercase. Bearer uses one canonical header declaration: `name: "authorization"` with `prefix: "Bearer "`. An `x-api-key` model profile uses `name: "x-api-key"` with `raw`. A query declaration applies to the decoded value of each occurrence of the exact named parameter; repeated occurrences do not change the permitted format. `basic` is distinct because the proxy substitutes inside a syntactically valid, base64-encoded Basic Authorization value. It does not restrict the placeholder to one Basic component.

A path template starts with `/` and has exactly one `{credential}` slot as a complete path segment. The `path` presentation matches that path; `path_subtree` also matches its slash-delimited descendants. The Proxy serializes the credential into that segment under the admitted wire-path rules. It checks both the original placeholder path and the outbound path against the separately admitted destination, method, and operation selector. It rejects an invalid encoding, a change to segment boundaries, or expansion outside the admitted operation.

The current operation selector supports literal paths and terminal `/**` subtrees, not credential slots. A path presentation can therefore use an existing subtree only when the template and every permitted expansion remain inside it. A literal operation cannot authorize an unknown credential-bearing outbound path; refuse that combination until a separately reviewed operation-template contract can express it. A presentation cannot authorize network access by itself.

The requester cannot supply an arbitrary presentation when binding an existing reviewed consumer. OCC derives it from that consumer's reviewed declaration, rejects missing or incompatible values, and preserves it in the admitted Agent revision. A Driver must refuse a presentation when it cannot enforce the complete declaration. Do not fall back to Bearer, accept an unknown string, or silently weaken a requested format.

## Native OpenShell custody

For an OpenShell-owned Source, delivery attaches the authoritative Provider without exporting the credential or creating another Provider containing the same value. A Source can be reused by bindings whose admitted presentations differ. A new binding must not mutate that Provider's profile, change another binding's effective presentation, or grant the union of those presentations to either binding. The current preview refuses two bindings of one native Source in the same Sandbox. Keep that refusal until OpenShell can distinguish the bindings and enforce their separate authority.

OpenShell 0.1.9 (`ce58cf8e9b953281352d98a637e41616295b1318`) supports profile styles `bearer`, `basic`, `header`, `query`, and `path`. Later upstream development adds `path_subtree`. The profile declaration belongs to a Provider credential, while the Sandbox endpoint's credential binding selects a Provider by name. There is no independent per-binding presentation in that interface. In addition, the 0.1.9 resolver compiles `bearer` and `basic` to the Authorization header location and does not distinguish their schemes. Query placement likewise does not restrict the format of the matching parameter value. These are upstream dependencies for strict reusable binding support: [independent binding presentation](https://github.com/ai-openshell/openshell/issues/5963) and [exact credential value format](https://github.com/ai-openshell/openshell/issues/5964). They do not authorize duplicate Source custody or weaker admission. The earlier first-run Bearer exception remains limited to its recorded scope; it does not approve a new presentation exception.

Admission must determine support from the selected Proxy/Sandbox pair and actual installed Gateway/supervisor capability. An SDK's ability to serialize a profile field is not enforcement proof. Except for the recorded first-run exception, native delivery must refuse a presentation until a qualified runtime can install and enforce the exact binding.

OpenShell's request-body and WebSocket-text rewriting use separate endpoint opt-ins. They do not follow from any profile presentation, and enabling either can bypass ordinary profile placement checks. Supporting those opt-ins requires a reviewed rule specifying the allowed message location, request operation, and content limits; this amendment does not grant them implicitly. AWS SigV4 signing uses multiple credential values and signing-specific request rules. Repository Git delivery likewise retains its admitted operation-specific profile. Neither is a scalar placeholder presentation in this union.

## Interface changes

### API

Source enrollment and client administration do not change. A reviewed consumer declaration must expose its typed presentation before OCC can admit a binding. If OCE accepts those declarations through a public Template or model API, that schema must carry the same canonical type; the exact API change needs review.

### IAM

No changes. Existing Source binding authority does not let a caller widen the consumer's reviewed presentation.

### Database entities

No new entity. The admitted revision records the canonical presentation as part of its binding; no additional usable Source value is retained by OCC.

### Driver contracts

Extend PluginDriver's reviewed credential slot and `DeploymentCredentialBinding.projection.presentation` to carry `CredentialPresentation`. The existing `CredentialProxyDriver.configureDeployment()` binding input carries the same type to each implementation. SandboxDriver must preserve the configured rule under the selected Proxy pairing. TokenServiceDriver custody and update contracts are unchanged.

## Simplifications

One presentation type replaces provider-specific presentation names and separate Plugin/model enums. Remove the old `x-api-key` special case when its reviewed profile can declare the equivalent raw header. Do not introduce a second Source update, push, retry, or credential export lifecycle.

A simpler design could fix one presentation when a Source is enrolled. That would make Source custody depend on its first consumer and prevent reuse across differently admitted bindings. A Provider per presentation would duplicate usable material and require another synchronization and cleanup lifecycle. Neither preserves the selected ownership model.

## Acceptance criteria

- A real reviewed consumer can bind a static Source using each supported presentation without a provider-type allowlist. A request at the admitted location succeeds; a request to the same destination with a different header, scheme, query parameter or value format, path, or subtree boundary fails before substitution.
- Bind one native Source to two separately authorized consumers with different presentations. Each receives its own authorized presentation; changing or withdrawing one binding does not change the other. Replacing the Source credential updates both through the existing lifecycle. OCC retains no usable Source secret, and native Source update and cleanup use the existing lifecycle.
- For an installed runtime lacking exact per-binding enforcement, preparation fails explicitly without changing existing bindings or copying the Source value. `path_subtree` remains unavailable on 0.1.9.
- For path presentations, qualify an allowed substitution within an admitted subtree, refusal with a literal exact operation, rejection of encoded delimiters or normalization that changes a segment, and rejection at the subtree boundary.
- Record the tested OCC commit, Gateway/supervisor image digests, actual launched versions, selected SDK version, real API/PostgreSQL path, admitted rules, allowed/denied request evidence, and genuine Agent workflow outcome. Tests with no real Proxy or runtime prove only their stated layer.

## Open decisions and dependencies

The OpenShell maintainers must define per-binding placement and exact value-format enforcement, including Authorization schemes and raw versus prefixed header and query values. OCE reviewers must approve the shared typed declaration and decide whether separately reviewed body or WebSocket rules belong in a later extension. No additional custody or security exception is proposed here.
