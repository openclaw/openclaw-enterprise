import type { PlatformReadView } from "./platform-read-view.ts";
import type { PlatformUnitOfWork } from "./platform-unit-of-work.ts";

export interface PlatformTransactionOptions {
  /** Read current committed state after lock waits, independent of session defaults. */
  readonly readCommitted?: boolean;
}

export interface PlatformStateStore {
  read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T>;
  transact<T>(
    work: (state: PlatformUnitOfWork) => Promise<T>,
    options?: PlatformTransactionOptions,
  ): Promise<T>;
}
