import { KeyObject, constants, sign } from "node:crypto";
import type { GitHubKeyOptions, GitHubKeyOwner } from "./types.ts";

/** The process owns this key; finalizing a session never closes it. */
export function createGitHubKeyOwner(options: GitHubKeyOptions): GitHubKeyOwner {
  let key: KeyObject | undefined = options.privateKey;
  const { appId, clock } = options;
  if (
    !(key instanceof KeyObject) ||
    key.type !== "private" ||
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) > 8192 ||
    !/^[1-9][0-9]{0,19}$/.test(appId)
  ) {
    throw new Error("invalid-signing-key");
  }
  return Object.freeze<GitHubKeyOwner>({
    kind: "github-app",
    async withJwt<T>(consume: (jwt: string, assertCurrent: () => void) => Promise<T>): Promise<T> {
      const assertCurrent = () => {
        if (!key) {
          throw new Error("authority-unavailable");
        }
      };
      assertCurrent();
      const now = Math.floor(clock.wallNow() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({ iat: now - 60, exp: now + 300, iss: appId }),
      ).toString("base64url");
      const unsigned = `${header}.${payload}`;
      const signature = sign("sha256", Buffer.from(unsigned), {
        key: key!,
        padding: constants.RSA_PKCS1_PADDING,
      }).toString("base64url");
      return consume(`${unsigned}.${signature}`, assertCurrent);
    },
    close() {
      key = undefined;
    },
  });
}
