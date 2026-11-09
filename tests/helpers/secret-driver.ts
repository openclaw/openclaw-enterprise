import { isDeepStrictEqual } from "node:util";

import type {
  Secret,
  SecretBackendRef,
  SecretIdentity,
} from "../../packages/contracts/src/index.ts";
import type {
  InstallationSecretRef,
  SecretDriver,
} from "../../packages/contracts/src/drivers/secret/index.ts";

interface TestSecretDriverOptions {
  id?: string;
  createError?: unknown;
  updateError?: unknown;
  deleteError?: unknown;
  resolveError?: unknown;
}

type SecretKey = Pick<SecretIdentity, "namespaceId" | "id">;

type ResolveOverride = (secret: Secret) => SecretBackendRef;

type SecretDriverCall =
  | { operation: "create"; identity: SecretIdentity; value: string }
  | { operation: "update"; secret: Secret; value: string }
  | {
      operation: "compareAndSwap";
      secret: Secret;
      expected: string;
      value: string;
    }
  | { operation: "delete"; secret: Secret }
  | { operation: "withValue"; secret: Secret }
  | { operation: "resolve"; secret: Secret };

interface SecretEntry {
  identity: SecretIdentity;
  backendRef: SecretBackendRef;
  value: string;
}

interface TestSecretControls {
  calls: SecretDriverCall[];
  setResolveOverride(next: ResolveOverride | undefined): void;
  valueFor(secret: SecretKey): string | undefined;
  has(secret: SecretKey): boolean;
}

/** Test-only passive storage; OCC still owns authorization, ownership, and metadata. */
export function createTestSecretDriver(options: TestSecretDriverOptions = {}) {
  const entries = new Map<string, SecretEntry>();
  const calls: SecretDriverCall[] = [];
  const privateEntries = new Map<string, string>();
  let resolveOverride: ResolveOverride | undefined;

  function keyOf(secret: SecretKey): string {
    return `${secret.namespaceId}:${secret.id}`;
  }

  function requireEntry(key: string, secret: Pick<Secret, "backendRef">): SecretEntry {
    const entry = entries.get(key);
    if (entry === undefined) {
      throw new Error("Secret does not exist.");
    }
    if (!isDeepStrictEqual(entry.backendRef, secret.backendRef)) {
      throw new Error("Secret backend identity changed.");
    }
    return entry;
  }

  function backendRefFor(identity: SecretKey): SecretBackendRef {
    const namespaceSuffix = identity.namespaceId.replace(/^ns_/, "").replaceAll("_", "-");
    const secretUid = identity.id.replace(/^sec_/, "");
    const objectSuffix = secretUid.replaceAll("-", "").slice(0, 32);
    return Object.freeze({
      namespaceName: `tenant-${namespaceSuffix.slice(0, 56)}`,
      name: `secret-${namespaceSuffix.slice(0, 16)}-${objectSuffix}`,
      key: "value",
      uid: secretUid,
    });
  }

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  const privateKey = (ref: InstallationSecretRef) => JSON.stringify([ref.installationId, ref.id]);

  const driver = {
    installationSecrets: {
      async create(ref, value) {
        const key = privateKey(ref);
        if (privateEntries.has(key)) {
          throw new Error("Installation Secret already exists.");
        }
        privateEntries.set(key, value);
      },
      async update(ref, value) {
        const key = privateKey(ref);
        if (!privateEntries.has(key)) {
          throw new Error("Installation Secret does not exist.");
        }
        privateEntries.set(key, value);
      },
      async withValue<T>(
        ref: InstallationSecretRef,
        use: (value: string) => Promise<T>,
      ): Promise<T> {
        const value = privateEntries.get(privateKey(ref));
        if (value === undefined) {
          throw new Error("Installation Secret does not exist.");
        }
        return use(value);
      },
      async delete(ref) {
        privateEntries.delete(privateKey(ref));
      },
    },
    id: options.id ?? "secret-test",
    capability: "secret",
    implementation: "test-passive-secret-storage",
    calls,
    setResolveOverride(next) {
      resolveOverride = next;
    },
    valueFor(secret) {
      return entries.get(keyOf(secret))?.value;
    },
    has(secret) {
      return entries.has(keyOf(secret));
    },
    async create(identity, value) {
      calls.push({ operation: "create", identity: clone(identity), value });
      if (options.createError !== undefined) {
        throw options.createError;
      }
      const key = keyOf(identity);
      if (entries.has(key)) {
        throw new Error("Secret already exists.");
      }
      const backendRef = backendRefFor(identity);
      entries.set(key, { identity: clone(identity), backendRef, value });
      return clone(backendRef);
    },
    async update(secret, value) {
      calls.push({ operation: "update", secret: clone(secret), value });
      if (options.updateError !== undefined) {
        throw options.updateError;
      }
      const key = keyOf(secret);
      const entry = requireEntry(key, secret);
      entries.set(key, { ...entry, value });
    },
    async compareAndSwap(secret, expected, value) {
      calls.push({
        operation: "compareAndSwap",
        secret: clone(secret),
        expected,
        value,
      });
      if (options.updateError !== undefined) {
        throw options.updateError;
      }
      const key = keyOf(secret);
      const entry = requireEntry(key, secret);
      if (entry.value !== expected) {
        return false;
      }
      entries.set(key, { ...entry, value });
      return true;
    },
    async delete(secret) {
      calls.push({ operation: "delete", secret: clone(secret) });
      if (options.deleteError !== undefined) {
        throw options.deleteError;
      }
      const key = keyOf(secret);
      if (entries.has(key)) {
        requireEntry(key, secret);
        entries.delete(key);
      }
    },
    async withValue<T>(secret: Secret, use: (value: string) => Promise<T>): Promise<T> {
      calls.push({ operation: "withValue", secret: clone(secret) });
      const entry = entries.get(keyOf(secret));
      if (entry === undefined || !isDeepStrictEqual(entry.backendRef, secret.backendRef)) {
        throw new Error("Secret backend is unavailable.");
      }
      return use(entry.value);
    },
    async resolve(secret) {
      calls.push({ operation: "resolve", secret: clone(secret) });
      if (options.resolveError !== undefined) {
        throw options.resolveError;
      }
      if (resolveOverride !== undefined) {
        return clone(resolveOverride(secret));
      }
      const entry = requireEntry(keyOf(secret), secret);
      return clone(entry.backendRef);
    },
  } satisfies SecretDriver & TestSecretControls;

  return driver;
}
