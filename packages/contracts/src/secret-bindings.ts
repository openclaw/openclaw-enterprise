import type { SecretBindings } from "./index.ts";

const reserved =
  /^(?:OPENCLAW_|CODEX_|OCC_|KUBERNETES_|KUBECONFIG$|APP_SERVER_|NODE_|LD_|DYLD_|PYTHON|SSL_|TLS_|NPM_|PNPM_|OTEL_)/i;
const controlNames = new Set([
  "LOG_FORMAT",
  "RUST_LOG",
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "IFS",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

const providerPrefix = /^(?:OPENAI_|ANTHROPIC_)/i;

/** The destination rule a Secret binding name breaks, or undefined when it is allowed. */
type SecretBindingDestinationRule = "invalid_format" | "reserved_prefix" | "reserved_name";

function destinationRule(name: string): SecretBindingDestinationRule | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,252}$/.test(name)) {
    return "invalid_format";
  }
  if (controlNames.has(name.toUpperCase()) || /^KUBECONFIG$/i.test(name)) {
    return "reserved_name";
  }
  if (reserved.test(name) || providerPrefix.test(name)) {
    return "reserved_prefix";
  }
  return undefined;
}

export function isAllowedSecretBindingDestination(name: string): boolean {
  return destinationRule(name) === undefined;
}

// Names the rule a destination broke and, when well-formed, the destination: the caller's own
// environment variable name, never a Secret value or ID. A malformed name is not echoed.
function destinationMessage(name: string, rule: SecretBindingDestinationRule): string {
  switch (rule) {
    case "invalid_format":
      return "A secret binding destination is not a valid environment variable name: it must match ^[A-Za-z_][A-Za-z0-9_]*$ and have at most 253 characters.";
    // The rule comes before the name, so a capped message still says which rule broke.
    case "reserved_name":
      return `A secret binding destination is a reserved process or platform variable name: ${name}.`;
    case "reserved_prefix":
      return `A secret binding destination uses the reserved prefix ${(
        (reserved.exec(name) ?? providerPrefix.exec(name))?.[0] ?? ""
      ).toUpperCase()}*: ${name}.`;
  }
}

/** One canonical, closed binding grammar, used at admission and rendering. */
export function normalizeSecretBindings(input: unknown): SecretBindings {
  if (input === undefined) {
    return Object.freeze({});
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Secret bindings must be an environment destination map.");
  }
  const entries = Object.entries(input);
  if (entries.length > 64) {
    throw new Error("Too many secret bindings.");
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(([name, binding]) => {
        const rule = destinationRule(name);
        if (rule !== undefined) {
          throw Object.assign(new Error(destinationMessage(name, rule)), {
            destination: name,
            destinationRule: rule,
          });
        }
        if (
          binding === null ||
          typeof binding !== "object" ||
          Array.isArray(binding) ||
          !Object.hasOwn(binding, "source") ||
          Object.keys(binding).some((key) => key !== "source" && key !== "delivery")
        ) {
          throw new Error("A secret binding must identify one supported source and delivery.");
        }
        const { source, delivery } = binding as Record<string, unknown>;
        if (
          source === null ||
          typeof source !== "object" ||
          Array.isArray(source) ||
          Object.keys(source).length !== 3 ||
          !("kind" in source) ||
          source.kind !== "secret" ||
          !("namespaceId" in source) ||
          typeof source.namespaceId !== "string" ||
          !source.namespaceId ||
          !("id" in source) ||
          typeof source.id !== "string" ||
          !source.id
        ) {
          throw new Error("A secret binding requires an exact Namespace-scoped Secret reference.");
        }
        if (
          delivery !== undefined &&
          (delivery === null ||
            typeof delivery !== "object" ||
            Array.isArray(delivery) ||
            Object.keys(delivery).length !== 1 ||
            !("type" in delivery) ||
            delivery.type !== "env")
        ) {
          throw new Error("The secret delivery mode is unsupported.");
        }
        return [
          name,
          Object.freeze({
            source: Object.freeze({
              kind: "secret" as const,
              namespaceId: source.namespaceId,
              id: source.id,
            }),
            delivery: Object.freeze({ type: "env" as const }),
          }),
        ];
      }),
    ),
  );
}
