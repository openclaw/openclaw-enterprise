import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { ResourceStateConflictError } from "./errors.ts";

export type DeviceAuthenticationState = DeviceAuthorizationSession & {
  readonly kind: "device_authorization";
  readonly id: string;
  readonly version: number;
};

/** OCC stores the user challenge and provider handle as separate ciphertexts. */
export interface DeviceAuthorizationSession {
  readonly actorId: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly harnessId: string;
  readonly credentialGatewayId: string;
  readonly credentialRefreshId: string;
  readonly sourceId: string;
  readonly phase: "pending" | "polling" | "ready" | "cancelled";
  readonly expiresAt: string;
  readonly nextPollAt: string;
  readonly intervalSeconds: number;
  readonly encryptedChallenge?: string;
  readonly privateState?: string;
}

export function cancelledDeviceAuthorization(
  session: DeviceAuthorizationSession,
): DeviceAuthorizationSession {
  const { encryptedChallenge: _challenge, privateState: _handle, ...metadata } = session;
  return { ...metadata, phase: "cancelled" };
}

export function deviceAuthorizationCipher(secret: string) {
  const key = createHmac("sha256", secret).update("occ-device-authorization-v1").digest();
  return {
    seal(value: string, scope: Buffer): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(scope);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    open(value: string, scope: Buffer): string {
      try {
        const bytes = Buffer.from(value, "base64");
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAAD(scope);
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          "utf8",
        );
      } catch {
        throw new ResourceStateConflictError(
          "This login is no longer available in OCE. Connect again.",
        );
      }
    },
  };
}

export function deviceAuthorizationScope(
  installationId: string,
  id: string,
  session: DeviceAuthorizationSession,
  purpose: "challenge" | "provider_handle",
): Buffer {
  return Buffer.from(
    JSON.stringify([
      installationId,
      session.namespaceId,
      id,
      session.actorId,
      session.agentId,
      session.harnessId,
      session.sourceId,
      session.credentialGatewayId,
      session.credentialRefreshId,
      purpose,
    ]),
  );
}
