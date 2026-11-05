import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";

/** The Harness authentication methods a Compute Driver delivers to one Harness topology. */
export interface HarnessAuthMethodRule {
  /** The Driver, as named in the message, for example `Kubernetes Compute`. */
  readonly compute: string;
  /** The Agent's Harness topology, for example `embedded OpenClaw`. */
  readonly topology: string;
  readonly accepted: readonly string[];
  /** The Agent settings that can fix a refusal: `harnessAuth`, plus `executionMode` where another topology helps. */
  readonly fix: string;
}

/**
 * The Agent's Harness authentication method must be one the Compute Driver delivers to the
 * Agent's Harness topology. The rule depends only on the Agent (its binding and execution mode)
 * and the Configuration's Harness, so Agent save, provisioning and deployment refuse it with
 * the same message: a ConfigurationHarnessError naming the Agent setting, which the API
 * answers with 400. What a method also needs from the Installation is checked after this.
 */
export function requireHarnessAuthMethod(rule: HarnessAuthMethodRule, method: string): void {
  const { accepted } = rule;
  if (!accepted.includes(method)) {
    const list =
      accepted.length === 1
        ? accepted[0]
        : `${accepted.slice(0, -1).join(", ")} or ${accepted.at(-1)}`;
    throw new ConfigurationHarnessError(
      `Agent setting harnessAuth.method must be ${list} for ${rule.topology} on ${rule.compute}: change ${rule.fix}.`,
    );
  }
}
