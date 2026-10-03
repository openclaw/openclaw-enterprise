import { ScopeViolationError } from "../errors.ts";

/**
 * Owns callback admission and drains complete repository operations before the
 * owner commits. Closing admissions does not interrupt accepted operations.
 * Ordinary caught repository conflicts keep their existing semantics.
 */
export class RepositoryTransactionLifetime {
  private accepting = true;
  private active = true;
  private readonly pending = new Set<Promise<void>>();

  assertActive(): void {
    if (!this.active) {
      throw new ScopeViolationError("The platform transaction is closed.");
    }
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new ScopeViolationError("The platform transaction is closed."));
    }
    const result = (async () => {
      this.assertActive();
      const value = await work();
      this.assertActive();
      return value;
    })();
    const settled = result.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return result;
  }

  async finish(): Promise<void> {
    this.accepting = false;
    await Promise.all(this.pending);
    this.active = false;
  }

  /** The owner closes backend access when transaction cleanup finishes. */
  close(): void {
    this.accepting = false;
    this.active = false;
  }
}
