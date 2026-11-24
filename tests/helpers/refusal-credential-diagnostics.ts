// Why OpenClaw cannot read a SecretRef, as [problem, step] (packages/occ/src/environment-
// references.ts): every refusal names one next step (finding 3067). `alias` is the default alias
// of the ref's source (secrets.defaults.<source>, else "default"). `substitutedAlias`: that alias
// holds an environment reference, which only the runtime resolves. `provider`: a provider
// secrets.providers does not configure for the source; `defaultAlias`: provider default while
// secrets.defaults.<source> names `alias`; `providerAlias`: a provider outside the alias grammar;
// `id`: an env id outside the grammar, with the `example` the step offers, if any. A null `alias`
// is one too long to offer by name.
type SecretRefSource = "env" | "file" | "exec" | "store";
type SecretRefDiagnostic = [problem: string, step: string];

const useDefaultAlias = (alias: string | null, source: SecretRefSource = "env"): string =>
  alias === null ? `use the secrets.defaults.${source} alias` : `use provider ${alias}`;
const UNREADABLE_SECRET_REFS = {
  providerless: (source: SecretRefSource = "env", alias = "default"): SecretRefDiagnostic => [
    "is a SecretRef without a provider",
    ["env", "store"].includes(source)
      ? `add provider ${alias}`
      : `add a provider that secrets.providers configures for ${source}`,
  ],
  substitutedAlias: (source: SecretRefSource = "env"): SecretRefDiagnostic => [
    "is a SecretRef without a provider",
    `add the provider secrets.defaults.${source} names`,
  ],
  provider: (
    provider: string,
    source: SecretRefSource = "env",
    alias: string | null = "default",
  ): SecretRefDiagnostic => [
    `uses secret provider ${provider}, not configured for ${source}`,
    `${["env", "store"].includes(source) ? `${useDefaultAlias(alias, source)}, or ` : ""}add it to secrets.providers`,
  ],
  defaultAlias: (
    alias: string,
    source: SecretRefSource = "env",
    offered: string | null = alias,
  ): SecretRefDiagnostic => [
    `uses secret provider default, but secrets.defaults.${source} names ${alias}`,
    `use ${offered === null ? "that provider" : `provider ${offered}`}`,
  ],
  providerAlias: (provider: string, alias: string | null = "default"): SecretRefDiagnostic => [
    `uses secret provider ${provider}, not a provider alias OpenClaw reads`,
    useDefaultAlias(alias),
  ],
  id: (id: string, example?: string | null): SecretRefDiagnostic => [
    `references ${id}, not an env id OpenClaw reads`,
    `use ${example ?? "A-Z, 0-9 and _, from a letter"}`,
  ],
  // A long provider shows quoted and cut, as a key in brackets.
  allowlist: (id: string, provider = "default"): SecretRefDiagnostic => [
    `references ${id}, which secrets.providers${provider.startsWith('"') ? `[${provider}]` : `.${provider}`}.allowlist omits`,
    "add it to that allowlist",
  ],
};
type DiagnosticArguments<Diagnostics> = {
  [Kind in keyof Diagnostics]: Diagnostics[Kind] extends (...args: infer Args) => unknown
    ? [kind: Kind, ...details: Args]
    : never;
}[keyof Diagnostics];

type SecretRefArguments = DiagnosticArguments<typeof UNREADABLE_SECRET_REFS>;

function secretRefDiagnostic(args: SecretRefArguments): SecretRefDiagnostic {
  switch (args[0]) {
    case "providerless":
      return UNREADABLE_SECRET_REFS.providerless(args[1], args[2]);
    case "substitutedAlias":
      return UNREADABLE_SECRET_REFS.substitutedAlias(args[1]);
    case "provider":
      return UNREADABLE_SECRET_REFS.provider(args[1], args[2], args[3]);
    case "defaultAlias":
      return UNREADABLE_SECRET_REFS.defaultAlias(args[1], args[2], args[3]);
    case "providerAlias":
      return UNREADABLE_SECRET_REFS.providerAlias(args[1], args[2]);
    case "id":
      return UNREADABLE_SECRET_REFS.id(args[1], args[2]);
    case "allowlist":
      return UNREADABLE_SECRET_REFS.allowlist(args[1], args[2]);
  }
}

// The problem alone, as SSH Compute states it for the reference it renders.
export const unreadableSecretRefProblem = (...diagnostic: SecretRefArguments): string =>
  secretRefDiagnostic(diagnostic)[0];
// The plugin secret input rule's refusal of a reference OpenClaw cannot read, which stops the
// Gateway at startup whatever the bindings (finding 3056).
export const unreadablePluginSecretRefusal = (
  setting: string,
  plugin: string,
  ...diagnostic: SecretRefArguments
): string => {
  const [problem, step] = secretRefDiagnostic(diagnostic);
  return `Configuration setting ${setting} ${problem}: ${step}, or remove plugins.entries.${plugin} or set its enabled to false.`;
};
// The same refusal of a whole `${NAME}` at an input with a runtime owner (beam, imap): OpenClaw
// reads it as a SecretRef only while NAME is unset, so deployment refuses it while unbound.
// Binding NAME is the step it names.
export const unboundUnreadablePluginSecretRefusal = (
  setting: string,
  plugin: string,
  name: string,
  ...diagnostic: SecretRefArguments
): string =>
  `Configuration setting ${setting} ${unreadableSecretRefProblem(...diagnostic)}: bind ${name} in secretBindings, or remove plugins.entries.${plugin} or set its enabled to false.`;
// The same refusal of a whole `${APP_SERVER_*}` there on an embedded or Dedicated OpenClaw Agent
// that never sets it (finding 3060).
export const appServerUnreadablePluginSecretRefusal = (
  setting: string,
  plugin: string,
  agent: "an embedded" | "a Dedicated OpenClaw",
  ...diagnostic: SecretRefArguments
): string =>
  `Configuration setting ${setting} ${unreadableSecretRefProblem(...diagnostic)}, and it is never set on ${agent} Agent: remove plugins.entries.${plugin} or set its enabled to false.`;
// The refusal of a gateway.auth.password object OpenClaw cannot read, which stops every start on
// every Compute (findings 3057, 3061, 3062): Configuration save, Agent save and deployment
// (packages/occ/src/configuration-settings.ts), and Kubernetes and Docker Compute admission and
// preparation, from one reader (`gatewayPasswordRequirement`). `keys`: an object with other keys;
// `shape`: an object OpenClaw does not read as a SecretRef, offering the generated reference on the
// default env alias.
const UNREADABLE_GATEWAY_PASSWORDS = {
  keys: (): SecretRefDiagnostic => [
    "holds keys other than source, provider and id, which OpenClaw refuses",
    "remove them",
  ],
  shape: (alias = "default"): SecretRefDiagnostic => [
    "is not a SecretRef OpenClaw reads",
    `use {source: "env", provider: "${alias}", id: "OPENCLAW_GATEWAY_PASSWORD"}`,
  ],
};
type GatewayPasswordArguments =
  SecretRefArguments | DiagnosticArguments<typeof UNREADABLE_GATEWAY_PASSWORDS>;

function gatewayPasswordDiagnostic(args: GatewayPasswordArguments): SecretRefDiagnostic {
  switch (args[0]) {
    case "keys":
      return UNREADABLE_GATEWAY_PASSWORDS.keys();
    case "shape":
      return UNREADABLE_GATEWAY_PASSWORDS.shape(args[1]);
    default:
      return secretRefDiagnostic(args);
  }
}

export const unreadableGatewayPasswordRefusal = (...diagnostic: GatewayPasswordArguments): string =>
  `Configuration setting gateway.auth.password ${gatewayPasswordDiagnostic(diagnostic).join(": ")}.`;
// The refusal of a secrets.defaults OpenClaw's configuration check refuses, which stops the
// Gateway at every start on every Compute (finding 3064): Configuration save, Agent save and
// deployment (`secretProviderDefaultsProblem`) and the console. `alias`: an alias outside the
// grammar on `source` (`shown` as the message shows it, absent for one that is not text; `fixed`:
// the alias the step offers, if any); `key`: a key other than a source; `shape`: secrets.defaults
// that is not an object.
type ProviderDefaultsDiagnostic = [setting: string, requirement: string];

const INVALID_SECRET_PROVIDER_DEFAULTS = {
  alias: (source: SecretRefSource, shown?: string, fixed?: string): ProviderDefaultsDiagnostic => [
    `secrets.defaults.${source}`,
    `${shown === undefined ? "is " : `is ${shown}, `}not a provider alias OpenClaw reads (a-z, 0-9, _ and -, from a lowercase letter, at most 64 characters): ${fixed === undefined ? "" : `use ${fixed}, or `}remove it`,
  ],
  key: (shown: string): ProviderDefaultsDiagnostic => [
    "secrets.defaults",
    `holds ${shown}, which OpenClaw refuses: name only env, file, exec or store`,
  ],
  shape: (): ProviderDefaultsDiagnostic => [
    "secrets.defaults",
    "must be an object that names a provider alias for env, file, exec or store",
  ],
};
type ProviderDefaultsArguments = DiagnosticArguments<typeof INVALID_SECRET_PROVIDER_DEFAULTS>;

function providerDefaultsDiagnostic(args: ProviderDefaultsArguments): ProviderDefaultsDiagnostic {
  switch (args[0]) {
    case "alias":
      return INVALID_SECRET_PROVIDER_DEFAULTS.alias(args[1], args[2], args[3]);
    case "key":
      return INVALID_SECRET_PROVIDER_DEFAULTS.key(args[1]);
    case "shape":
      return INVALID_SECRET_PROVIDER_DEFAULTS.shape();
  }
}

export const invalidSecretProviderDefaultsRefusal = (
  ...diagnostic: ProviderDefaultsArguments
): string => {
  const [setting, requirement] = providerDefaultsDiagnostic(diagnostic);
  return `Configuration setting ${setting} ${requirement}.`;
};
// SSH Compute's refusals of a gateway.auth.password it cannot deliver (finding 3065): `reference`,
// a password other than the expression or an env SecretRef to the generated password, offering it
// on the default env alias; `rendered`, an unset password or the expression in password mode when
// the default-provider reference SSH Compute renders then is unreadable (`requirement` says why),
// offering the reference on the default env alias; `unoffered`, the same when OpenClaw cannot read
// that reference either, so no reference is offered.
export const sshGatewayPasswordRefusal = {
  unoffered: (requirement: string): string =>
    `Configuration setting gateway.auth.password must be set to an env SecretRef to OPENCLAW_GATEWAY_PASSWORD that OpenClaw reads: SSH Compute's default reference ${requirement}.`,
  reference: (alias = "default"): string =>
    `Configuration setting gateway.auth.password must be "\${OPENCLAW_GATEWAY_PASSWORD}" or the environment SecretRef {source: "env", provider: "${alias}", id: "OPENCLAW_GATEWAY_PASSWORD"}, whose value SSH Compute generates.`,
  rendered: (alias: string, requirement: string): string =>
    `Configuration setting gateway.auth.password must be set to {source: "env", provider: "${alias}", id: "OPENCLAW_GATEWAY_PASSWORD"}: SSH Compute's default reference ${requirement}.`,
};
