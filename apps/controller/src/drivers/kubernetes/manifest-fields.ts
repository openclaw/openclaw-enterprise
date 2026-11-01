import { isDeepStrictEqual } from "node:util";

// The client keeps these out of its index; the package has no export map and is pinned exactly.
import { ObjectSerializer } from "@kubernetes/client-node/dist/serializer.js";
import { getSerializationType } from "@kubernetes/client-node/dist/util.js";
import { asRecord } from "@openclaw-enterprise/utils";

import { networkPolicyToSdk } from "./network-policy.ts";

const pointerToken = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * JSON Pointers, relative to `manifest`, of the fields `KubernetesObjectApi` would not send as
 * written. The client serializes built-in kinds through typed models that silently drop every
 * key they do not model, at any depth, and the metadata of other kinds through `V1ObjectMeta`
 * (finding 3111): a `matchLabel` typo in a selector becomes `{}`, which selects all Pods, and
 * LimitRange `default` is dropped because the model names it `_default`. Values the client
 * passes through unchanged (int-or-string, `null`, empty objects and arrays) compare equal.
 */
export function unsentManifestFields(
  manifest: { readonly apiVersion?: string; readonly kind?: string },
  limit = 8,
): string[] {
  // Map exactly as the apply path does, so the mapped ingress `from` is not reported.
  const resource = networkPolicyToSdk(manifest);
  let sent: unknown;
  try {
    sent = JSON.parse(
      JSON.stringify(
        ObjectSerializer.serialize(
          resource,
          getSerializationType(resource.apiVersion, resource.kind),
        ),
      ),
    );
  } catch {
    // The client cannot serialize it at all (for example an object where it expects a list).
    return [""];
  }
  const lost: string[] = [];
  compare(JSON.parse(JSON.stringify(manifest)), sent, "", lost, limit);
  return lost.slice(0, limit);
}

function compare(
  written: unknown,
  sent: unknown,
  pointer: string,
  lost: string[],
  limit: number,
): void {
  if (lost.length >= limit || isDeepStrictEqual(written, sent)) {
    return;
  }
  if (Array.isArray(written) && Array.isArray(sent) && written.length === sent.length) {
    written.forEach((item, index) =>
      compare(item, sent[index], `${pointer}/${index}`, lost, limit),
    );
    return;
  }
  const writtenFields = asRecord(written);
  const sentFields = asRecord(sent);
  if (writtenFields === undefined || sentFields === undefined) {
    // A value of the wrong shape for its model: the client sends something else.
    lost.push(pointer);
    return;
  }
  const before = lost.length;
  for (const [key, value] of Object.entries(writtenFields)) {
    const child = `${pointer}/${pointerToken(key)}`;
    if (!Object.hasOwn(sentFields, key)) {
      lost.push(child);
    } else {
      compare(value, sentFields[key], child, lost, limit);
    }
  }
  if (lost.length === before) {
    // Every written field survived, yet the objects differ: never report that as a match.
    lost.push(pointer);
  }
}
