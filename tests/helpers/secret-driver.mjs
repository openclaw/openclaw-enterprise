import { isDeepStrictEqual } from "node:util";

/** Test-only passive storage; OCC still owns authorization, ownership, and metadata. */
export function createTestSecretDriver(options = {}) {
  const entries = new Map();
  const calls = [];
  let resolveOverride;

  function keyOf(secret) {
    return `${secret.namespaceId}:${secret.id}`;
  }

  function requireEntry(key, secret) {
    const entry = entries.get(key);
    if (entry === undefined) {
      throw new Error("Secret does not exist.");
    }
    if (!isDeepStrictEqual(entry.backendRef, secret.backendRef)) {
      throw new Error("Secret backend identity changed.");
    }
    return entry;
  }

  function backendRefFor(identity) {
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

  function clone(value) {
    return structuredClone(value);
  }

  const driver = {
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
      calls.push({ operation: "compareAndSwap", secret: clone(secret), expected, value });
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
      requireEntry(key, secret);
      entries.delete(key);
    },
    async withValue(secret, use) {
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
  };

  return driver;
}
