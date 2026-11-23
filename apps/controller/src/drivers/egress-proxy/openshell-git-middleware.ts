import type { compileOpenShellBoundGitRule } from "../sandbox/openshell-git-network-policy.ts";

export const onlineRequestImplementation = "online-request-authorization";

export type NativeRestMode = "read" | "write";

/** Only the compiled, credential-bound routes select the validator, including after a downgrade. */
export function nativeRestMode(
  rule: ReturnType<typeof compileOpenShellBoundGitRule> | undefined,
): NativeRestMode | undefined {
  const endpoints = rule?.endpoints.filter(({ host }) => host === "api.github.com");
  if (!endpoints?.length) {
    return;
  }
  return endpoints.some(
    (endpoint) =>
      "rules" in endpoint && endpoint.rules.some(({ allow }) => allow.method === "POST"),
  )
    ? "write"
    : "read";
}

/** One policy definition, compared again by the Credential Proxy at Compute release. */
export function openShellGitMiddleware(
  registrationName: string,
  bindingId: string,
  native = false,
  rest?: NativeRestMode,
) {
  return {
    "oce-prepared-git": {
      name: "oce-prepared-git",
      middleware: registrationName,
      config: { fields: { binding_id: { stringValue: bindingId } } },
      on_error: "fail_closed",
      order: 2147483647,
      // Stock 0.1.9 selects middleware by host. PR creation also puts API reads on the hook.
      endpoints: {
        include: native
          ? [rest === "read" ? "deny-egress.invalid" : "api.github.com"]
          : ["github.com", "api.github.com"],
      },
    },
  };
}
