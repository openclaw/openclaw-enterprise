import { GatewayClient } from "@openclaw/gateway-client";
import type { AgentGatewayPerson } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerGatewayPeopleAccess, ControllerGatewayPeopleRequest } from "./contracts.ts";

interface GatewayPeopleTarget {
  readonly url: string;
  readonly apiKey: string;
}

type ResolveTarget = (
  request: ControllerGatewayPeopleRequest,
) => Promise<GatewayPeopleTarget | undefined>;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export function createNativeGatewayPeopleAccess(
  resolveTarget: ResolveTarget,
): ControllerGatewayPeopleAccess {
  return {
    async list(request) {
      const target = await resolveTarget(request);
      if (target === undefined) {
        throw new Error("Gateway profiles are unavailable.");
      }
      const signal = requestSignal(request);
      let connected!: () => void;
      let refused!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        connected = resolve;
        refused = reject;
      });
      const abort = () => refused(new Error("Gateway profile request aborted."));
      signal.addEventListener("abort", abort, { once: true });
      const client = new GatewayClient({
        url: target.url,
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        deviceIdentity: null,
        scopes: [],
        edgeAuthHeaders: { "x-api-key": target.apiKey },
        onHelloOk: (hello) => {
          if (hello.auth?.role === "operator" && hello.auth.scopes.includes("operator.admin")) {
            connected();
          } else {
            refused(new Error("Gateway profile authority is unavailable."));
          }
        },
        onConnectError: refused,
      });
      try {
        signal.throwIfAborted();
        client.start();
        await ready;
        const payload = asRecord(await client.request("users.list", {}, { signal }));
        if (!Array.isArray(payload?.profiles)) {
          throw new Error("Invalid Gateway profiles response.");
        }
        const people: AgentGatewayPerson[] = [];
        for (const value of payload.profiles) {
          const profile = asRecord(value);
          if (!profile || !isNonEmptyString(profile.id) || profile.id.length > 200) {
            throw new Error("Invalid Gateway profile.");
          }
          // Shared service/owner profiles and merged aliases are not additional humans.
          if (
            profile.id === "gateway-owner" ||
            profile.mergedInto ||
            (Array.isArray(profile.emails) && profile.emails.includes("occ-workspace-files"))
          ) {
            continue;
          }
          people.push({
            id: profile.id,
            displayName: typeof profile.displayName === "string" ? profile.displayName : "",
            role: typeof profile.effectiveRole === "string" ? profile.effectiveRole : null,
            hasAvatar: profile.hasAvatar === true,
          });
        }
        return people;
      } finally {
        signal.removeEventListener("abort", abort);
        client.stop();
        await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
      }
    },
    async avatar(request) {
      const target = await resolveTarget(request);
      if (target === undefined) {
        throw new Error("Gateway avatar is unavailable.");
      }
      const url = new URL(target.url);
      url.protocol = "https:";
      url.pathname =
        url.pathname.replace(/\/$/, "") +
        `/api/users/${encodeURIComponent(request.profileId)}/avatar`;
      const response = await fetch(url, {
        headers: { "x-api-key": target.apiKey },
        redirect: "error",
        signal: requestSignal(request),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      const mime = response.headers.get("content-type")?.split(";")[0];
      if (!response.ok || !mime || !IMAGE_TYPES.has(mime) || !response.body) {
        await response.body?.cancel();
        throw new Error("Gateway avatar is unavailable.");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          length += chunk.value.byteLength;
          if (length > MAX_AVATAR_BYTES) {
            throw new Error("Gateway avatar exceeds the supported size.");
          }
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      return { mime, bytes: Buffer.concat(chunks) };
    },
  };
}

function requestSignal(request: ControllerGatewayPeopleRequest): AbortSignal {
  const remaining = request.deadline.getTime() - Date.now();
  return AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(0, Math.floor(remaining)))]);
}
