import type { Clock, RepositoryBackend, RepositoryBackendFactory } from "./backend-contracts.ts";
import type { ServiceConfig } from "./service-contracts.ts";
import { createCustody } from "./custody.ts";
import { createLifecycle } from "./lifecycle.ts";
import type { LifecycleOwner } from "./lifecycle.ts";
import { createProviderQueue } from "./provider-queue.ts";
import type { ProviderQueue } from "./provider-queue.ts";
import { snapshotBinding } from "./sessions.ts";
import type { SessionConstructor } from "./session-construction.ts";

/** Development owns acquisition, custody and retirement; the service owns admission. */
export function developmentSessionConstructor(
  options: Readonly<{
    factory: RepositoryBackendFactory;
    config: ServiceConfig;
    clock: Clock;
    providerQueue?: ProviderQueue;
  }>,
): SessionConstructor {
  const { factory, clock } = options;
  const limits = Object.freeze({ ...options.config.limits });
  const queue = options.providerQueue ?? createProviderQueue(limits.providerQueue);
  return (admission, _resolved, hooks) => {
    let lifecycle: LifecycleOwner | undefined = undefined;
    let constructing = true;
    const custody = createCustody({
      clock,
      maximumSlots: limits.credentialSlotsPerSession,
      maximumAccessBytes: limits.accessTokenBytes,
      maximumRenewalBytes: limits.renewalBytesPerSession,
      maximumCallbacks: limits.exchangesPerSession + 1,
      admitted: () => hooks.accepting() && (constructing || hooks.admitted()),
      changed: () => {
        if (!constructing) {
          lifecycle?.maintain();
        }
        hooks.changed();
      },
    });
    let driver: RepositoryBackend;
    try {
      driver = factory.create({
        authority: admission.authority,
        custody: custody.driver,
        clock,
      });
      const binding = snapshotBinding(driver.binding);
      if (
        binding.providerInstanceId !== admission.binding.providerInstanceId ||
        binding.repositoryId !== admission.binding.repositoryId ||
        binding.grantId !== admission.binding.grantId
      ) {
        throw new Error("DRIVER_BINDING_MISMATCH");
      }
    } catch (error) {
      constructing = false;
      // No valid driver exists to finalize this custody. Retain its capacity
      // and shutdown obligation until every admitted renewal callback drains.
      hooks.retainFailure(custody.disposeAllRenewal());
      throw error;
    }
    constructing = false;
    const authority = hooks.authorizeStanding
      ? { authorizeStanding: () => hooks.authorizeStanding!(admission.authority.sessionId) }
      : {};
    lifecycle = createLifecycle({
      ...authority,
      clock,
      authority: admission.authority,
      deadlineMonoMs: admission.deadlineMonoMs,
      custody,
      driver,
      queue,
      providerActionMs: limits.providerActionMs,
      safetyMarginMs: limits.credentialMarginMs,
      admitted: hooks.admitted,
      changed: hooks.changed,
    });
    return { owned: { custody, driver, lifecycle, ...authority } };
  };
}
