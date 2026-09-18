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
        if (
          !/^[A-Za-z_][A-Za-z0-9_]{0,252}$/.test(name) ||
          reserved.test(name) ||
          controlNames.has(name.toUpperCase()) ||
          name.toUpperCase().startsWith("OPENAI_")
        ) {
          throw new Error("A secret binding uses a reserved or invalid environment destination.");
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
