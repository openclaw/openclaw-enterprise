import type { RepositoryTransactionLifetime } from "./transaction.ts";

/**
 * Wrap only the outward projection. Internal repository collaborators retain
 * backend access while already accepted operations drain. Method names are
 * explicit so class-backed projections do not lose prototype methods.
 */
export function bindRepository<Repository extends object, Key extends keyof Repository>(
  repository: Repository,
  lifetime: RepositoryTransactionLifetime,
  methods: readonly Key[],
): Pick<Repository, Key> {
  const result = {} as Pick<Repository, Key>;
  for (const key of methods) {
    const method = repository[key];
    if (typeof method !== "function") throw new TypeError("A repository method is required.");
    Object.defineProperty(result, key, {
      enumerable: true,
      value: (...args: unknown[]) => lifetime.run(() => Reflect.apply(method, repository, args)),
    });
  }
  return Object.freeze(result);
}
