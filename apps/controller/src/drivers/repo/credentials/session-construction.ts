import type {
  PreparedRepositoryBackend,
  PreparedRepositoryBackendFactory,
  BoundPreparedRepositoryBackendFactory,
  RepositoryBackend,
  ResolvedGrant,
} from "./backend-contracts.ts";
import type { CustodyOwner } from "./custody.ts";
import type { LifecycleOwner } from "./lifecycle.ts";
import type { SessionAdmission } from "./sessions.ts";
import { sameBinding } from "./grant-identity.ts";

export interface ConstructedSession {
  readonly prepared?: PreparedRepositoryBackend;
  readonly owned?: Readonly<{
    custody: CustodyOwner;
    lifecycle: LifecycleOwner;
    driver: RepositoryBackend;
  }>;
}

export type SessionConstructor = (
  admission: Omit<SessionAdmission, "bearer">,
  resolved: ResolvedGrant,
  hooks: Readonly<{
    accepting(): boolean;
    admitted(): boolean;
    changed(): void;
    retainFailure(drained: Promise<void>): void;
  }>,
) => ConstructedSession;

export function preparedSessionConstructor(
  factory: PreparedRepositoryBackendFactory | BoundPreparedRepositoryBackendFactory,
): SessionConstructor {
  return (admission, resolved) => {
    const prepared = factory.createPrepared(admission.authority, resolved);
    if (!sameBinding(prepared.binding, admission.binding)) {
      throw new Error("DRIVER_BINDING_MISMATCH");
    }
    return { prepared };
  };
}
