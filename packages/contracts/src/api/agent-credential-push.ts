import { Type } from "typebox";

import { CredentialSourceId, MAX_AGENT_CREDENTIAL_SOURCES, Meta } from "./common.ts";

export const PushAgentCredentialsBody = Type.Object(
  {
    sources: Type.Union(
      [
        Type.Literal("all"),
        Type.Array(CredentialSourceId, {
          minItems: 1,
          maxItems: MAX_AGENT_CREDENTIAL_SOURCES,
          uniqueItems: true,
        }),
      ],
      {
        description:
          "Select 'all' or 1–64 distinct Source IDs to retry. Eligible Sources have an unwithdrawn Credential Proxy binding in the deployed Agent revision. The Agent service principal must still have credential_source:operate on each Source.",
      },
    ),
  },
  {
    $id: "PushAgentCredentialsBody",
    additionalProperties: false,
    description:
      "Manual delivery retry request. The caller needs agent:operate on the exact Agent and credential_source:update on every selected source. OCC rejects the whole request if any selected source is ineligible or unauthorized, before notifying the Credential Proxy or resolving any credential. Retrying delivery for a shared source can affect other Agents bound to it.",
  },
);

const pushResult = Type.Object(
  {
    sourceId: CredentialSourceId,
    outcome: Type.Union([
      Type.Literal("succeeded", {
        description:
          "The Credential Proxy completed the update notification according to its binding. A push confirms that every serving copy can use the resolved version. If no delivery resource exists, the proxy succeeds without resolving or creating one.",
      }),
      Type.Literal("resolution_failed", {
        description: "The proxy requested the credential, but its source-bound resolver failed.",
      }),
      Type.Literal("delivery_failed", {
        description:
          "The Credential Proxy could not complete the update notification, including when material required for a push had no resolved version.",
      }),
    ]),
  },
  { additionalProperties: false },
);

export const PushAgentCredentialsResponse = Type.Object(
  {
    data: Type.Object({ results: Type.Array(pushResult) }, { additionalProperties: false }),
    meta: Meta,
  },
  {
    $id: "PushAgentCredentialsResponse",
    additionalProperties: false,
    description:
      "Response after authorization. OCC reports one outcome per selected source, including successes when another source fails. A delivery failure does not roll back the authoritative credential. An authorized caller can retry delivery again.",
  },
);

export type PushAgentCredentialsBody = Type.Static<typeof PushAgentCredentialsBody>;
export type PushAgentCredentialsResponse = Type.Static<typeof PushAgentCredentialsResponse>;
