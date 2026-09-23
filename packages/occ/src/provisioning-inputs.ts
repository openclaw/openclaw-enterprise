import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = 1;
const CIPHER = "aes-256-gcm";
const FINGERPRINT = "hmac-sha256";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ProvisioningInputContext {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly workId: string;
  readonly slot: string;
}

export interface SealedProvisioningInput {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface ProvisioningInputFingerprint {
  readonly version: 1;
  readonly algorithm: "hmac-sha256";
  readonly keyId: string;
  readonly digest: string;
}

export interface ProtectedProvisioningInput {
  readonly sealed: SealedProvisioningInput;
  readonly fingerprint: ProvisioningInputFingerprint;
}

export interface ProvisioningInputKeyMaterial {
  readonly id: string;
  readonly material: string;
}

export interface ProvisioningInputKeyring {
  readonly primaryKeyId: string;
  readonly keys: readonly ProvisioningInputKeyMaterial[];
}

export interface ProvisioningInputProtector {
  readonly primaryKeyId: string;
  readonly availableKeyIds: readonly string[];
  protect(value: string, context: ProvisioningInputContext): ProtectedProvisioningInput;
  reveal(input: SealedProvisioningInput, context: ProvisioningInputContext): string;
  fingerprint(
    value: string,
    context: ProvisioningInputContext,
    keyId?: string,
  ): ProvisioningInputFingerprint;
  matchesFingerprint(
    value: string,
    context: ProvisioningInputContext,
    fingerprint: ProvisioningInputFingerprint,
  ): boolean;
}

function invalid(message: string): never {
  throw new Error(message);
}

function assertSafeString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    invalid(`${label} must be a nonempty safe string.`);
  }
}

function assertContext(context: ProvisioningInputContext): void {
  assertSafeString(context.installationId, "Provisioning input Installation ID");
  assertSafeString(context.namespaceId, "Provisioning input Namespace ID");
  assertSafeString(context.agentId, "Provisioning input Agent ID");
  assertSafeString(context.workId, "Provisioning input work ID");
  assertSafeString(context.slot, "Provisioning input slot");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function associatedData(purpose: "seal" | "fingerprint", context: ProvisioningInputContext) {
  assertContext(context);
  return Buffer.from(
    canonicalJson({
      version: VERSION,
      purpose: `occ.provisioning-input.${purpose}`,
      installationId: context.installationId,
      namespaceId: context.namespaceId,
      agentId: context.agentId,
      workId: context.workId,
      slot: context.slot,
    }),
    "utf8",
  );
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string, label: string): Buffer {
  if (typeof value !== "string" || value.trim().length === 0 || !BASE64URL_PATTERN.test(value)) {
    invalid(`${label} must be base64url-encoded.`);
  }
  return Buffer.from(value, "base64url");
}

function keyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    invalid("Provisioning input key IDs must be nonempty safe identifiers.");
  }
  return value;
}

function material(value: unknown): Buffer {
  if (typeof value !== "string") {
    invalid("Provisioning input keys must be base64url-encoded.");
  }
  const decoded = decode(value, "Provisioning input key");
  if (decoded.byteLength !== KEY_BYTES) {
    invalid("Provisioning input keys must contain 256 bits of material.");
  }
  return decoded;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function parseProvisioningInputKeyring(value: unknown): ProvisioningInputKeyring {
  const record = readRecord(value, "Provisioning input keyring");
  const primaryKeyId = keyId(record.primaryKeyId);
  if (!Array.isArray(record.keys) || record.keys.length === 0) {
    invalid("Provisioning input keyring must include at least one key.");
  }
  const seen = new Set<string>();
  const keys = record.keys.map((entry) => {
    const item = readRecord(entry, "Provisioning input key");
    const id = keyId(item.id);
    if (seen.has(id)) {
      invalid("Provisioning input keyring contains duplicate key IDs.");
    }
    seen.add(id);
    material(item.material);
    return Object.freeze({ id, material: item.material as string });
  });
  if (!seen.has(primaryKeyId)) {
    invalid("Provisioning input keyring primary key is not present.");
  }
  return Object.freeze({ primaryKeyId, keys });
}

export function createProvisioningInputProtector(
  keyring: ProvisioningInputKeyring,
): ProvisioningInputProtector {
  const parsed = parseProvisioningInputKeyring(keyring);
  const keys = new Map(parsed.keys.map((entry) => [entry.id, material(entry.material)]));

  function requireKey(id: string): Buffer {
    const key = keys.get(id);
    if (key === undefined) {
      invalid("Provisioning input key is unavailable.");
    }
    return key;
  }

  function fingerprint(
    value: string,
    context: ProvisioningInputContext,
    selectedKeyId = parsed.primaryKeyId,
  ): ProvisioningInputFingerprint {
    if (typeof value !== "string") {
      invalid("Provisioning input value must be a string.");
    }
    const id = keyId(selectedKeyId);
    const digest = createHmac("sha256", requireKey(id))
      .update(associatedData("fingerprint", context))
      .update("\0", "utf8")
      .update(value, "utf8")
      .digest();
    return Object.freeze({
      version: VERSION,
      algorithm: FINGERPRINT,
      keyId: id,
      digest: encode(digest),
    });
  }

  return Object.freeze({
    primaryKeyId: parsed.primaryKeyId,
    availableKeyIds: Object.freeze([...keys.keys()]),
    protect(value: string, context: ProvisioningInputContext): ProtectedProvisioningInput {
      if (typeof value !== "string") {
        invalid("Provisioning input value must be a string.");
      }
      const key = requireKey(parsed.primaryKeyId);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(CIPHER, key, nonce);
      cipher.setAAD(associatedData("seal", context));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Object.freeze({
        sealed: Object.freeze({
          version: VERSION,
          algorithm: CIPHER,
          keyId: parsed.primaryKeyId,
          nonce: encode(nonce),
          ciphertext: encode(ciphertext),
          tag: encode(tag),
        }),
        fingerprint: fingerprint(value, context, parsed.primaryKeyId),
      });
    },
    reveal(input: SealedProvisioningInput, context: ProvisioningInputContext): string {
      if (input.version !== VERSION || input.algorithm !== CIPHER) {
        invalid("Provisioning input envelope is unsupported.");
      }
      const key = requireKey(keyId(input.keyId));
      const nonce = decode(input.nonce, "Provisioning input nonce");
      if (nonce.byteLength !== NONCE_BYTES) {
        invalid("Provisioning input envelope is invalid.");
      }
      const tag = decode(input.tag, "Provisioning input authentication tag");
      const decipher = createDecipheriv(CIPHER, key, nonce);
      decipher.setAAD(associatedData("seal", context));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([
          decipher.update(decode(input.ciphertext, "Provisioning input ciphertext")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        invalid("Provisioning input envelope failed authentication.");
      }
    },
    fingerprint,
    matchesFingerprint(
      value: string,
      context: ProvisioningInputContext,
      expected: ProvisioningInputFingerprint,
    ): boolean {
      if (expected.version !== VERSION || expected.algorithm !== FINGERPRINT) {
        invalid("Provisioning input fingerprint is unsupported.");
      }
      const actual = fingerprint(value, context, expected.keyId);
      const left = decode(actual.digest, "Provisioning input fingerprint");
      const right = decode(expected.digest, "Provisioning input fingerprint");
      return left.byteLength === right.byteLength && timingSafeEqual(left, right);
    },
  });
}
