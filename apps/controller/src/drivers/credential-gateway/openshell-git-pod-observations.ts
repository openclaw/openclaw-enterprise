import { isDeepStrictEqual } from "node:util";
import type { OpenShellGitSupervisorPod } from "../kubernetes/openshell-git-supervisor.ts";

export type AdmittedGitPod = Omit<OpenShellGitSupervisorPod, "sandboxOwnerUid">;

type Observation = {
  ownerUid?: string;
  valid: boolean;
  readonly location: string;
  readonly identity: string;
};

/** Issuer-local negative knowledge, retained only by overlapping request lifetimes. */
export class OpenShellGitPodObservations {
  private readonly active = new Set<Observation>();

  observe(admitted: AdmittedGitPod, lifetime: AbortSignal) {
    lifetime.throwIfAborted();
    const observation: Observation = {
      valid: true,
      location: JSON.stringify([admitted.namespace, admitted.sandboxId]),
      identity: JSON.stringify([
        admitted.namespace,
        admitted.sandboxName,
        admitted.sandboxId,
        admitted.podUid,
      ]),
    };
    this.active.add(observation);
    lifetime.addEventListener("abort", () => this.active.delete(observation), { once: true });
    const isCurrent = () => observation.valid && !lifetime.aborted;
    return {
      identity: observation.identity,
      isCurrent,
      check: async (read: () => Promise<OpenShellGitSupervisorPod>, signal: AbortSignal) => {
        let rejectAbort: (() => void) | undefined;
        try {
          signal.throwIfAborted();
          const current = await Promise.race([
            new Promise<never>((_resolve, reject) => {
              rejectAbort = () => reject(new Error("Git Pod observation aborted."));
              signal.addEventListener("abort", rejectAbort, { once: true });
              if (signal.aborted) {
                rejectAbort();
              }
            }),
            read(),
          ]);
          signal.throwIfAborted();
          const { sandboxOwnerUid, ...identity } = current;
          if (!isDeepStrictEqual(identity, admitted)) {
            throw new Error("Git Pod observation does not match admission.");
          }
          observation.ownerUid = sandboxOwnerUid;
          // OwnerReferences can change on a live Pod. Contradictory simultaneous
          // observations cannot establish continuity for either request.
          for (const other of this.active) {
            if (
              other.identity === observation.identity &&
              other.ownerUid &&
              other.ownerUid !== sandboxOwnerUid
            ) {
              throw new Error("Supervisor Sandbox owner changed.");
            }
          }
        } catch (error) {
          // Publish actual Pod failure even if this request's credential was already denied.
          // Ended requests and late results of ignored cancellation cannot publish new evidence.
          if (!lifetime.aborted) {
            for (const active of this.active) {
              if (active.identity === observation.identity) {
                active.valid = false;
              }
            }
          }
          throw error;
        } finally {
          if (rejectAbort) {
            signal.removeEventListener("abort", rejectAbort);
          }
        }
        // An obsolete positive snapshot cannot restore itself or fence a successor.
        // Checking the guard is not a new failed Pod read.
        if (!isCurrent()) {
          throw new Error("Git Pod observation is no longer current.");
        }
        for (const active of this.active) {
          if (
            active.location === observation.location &&
            active.identity !== observation.identity
          ) {
            active.valid = false;
          }
        }
      },
    };
  }
}
