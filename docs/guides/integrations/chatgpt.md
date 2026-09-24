# Use the ChatGPT Backend (experimental)

> **Experimental / work in progress.** This guide covers the current managed
> service-account workflow. Read the [Backend scope and limits](../../reference/backends.md)
> before configuring it.

The ChatGPT Backend lets an Installation issue ChatGPT service-account
credentials for dedicated Codex Agents. It manages accounts and credentials;
it does not choose the model or route inference. If you already have an OpenAI
API key, use [Agent model authentication](../../reference/agents.md#harness-authentication)
instead; you do not need a Backend.

## Before you start

An Installation operator needs Kubernetes Compute, PostgreSQL, the upstream
workspace ID, and an admin key authorized for that workspace with
`chatgpt.enterprise.service_account.write`. The key must be available to the OCC
API as a mounted file. Only one ChatGPT Backend is supported per Installation.

The person creating an account needs permission to create service accounts in
the Namespace and update the new account to issue its credential. The person
associating or deploying an Agent needs `read` on that exact account. See
[service-account permissions](../../reference/service-accounts.md#account-ownership-and-authorization).

## Configure and use the Backend

1. As the Installation operator, add the ChatGPT Backend and matching
   `service_account` Driver to the trusted Installation YAML. In production,
   configure the Helm Secret mount and confirm that API Pods can reach
   `api.chatgpt.com:443`. The Helm value only permits a destination; it does not
   configure a forward proxy. Follow the [Installation settings](../../reference/backends.md#installation-configuration)
   and [production networking requirements](../../reference/backends.md#production-packaging-and-verification).
2. Confirm that the Backend appears in `GET /backends`. This requires
   `administer` on the Installation and checks OCC configuration only; it does
   not call ChatGPT or validate the admin key.
3. In the Agent's Namespace, create a service account with
   `POST /namespaces/:namespaceId/service-accounts` and a body such as
   `{"name":"support-model"}`. Save the returned `data.id`. Then issue its credential
   separately with
   `POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials`
   and the body `{}`. Both requests return `201`. Use the
   [verification example](#verify-backend-access) for the second request. See the
   [service-account lifecycle](../../reference/service-accounts.md#account-and-credential-lifecycle).
4. On a dedicated Codex Agent, select the configured `backendId` and that
   account for model authentication. For example, adapt this fragment for the
   Agent create or update request:

   ```json
   {
     "backendId": "openai",
     "harnessAuth": {
       "method": "chatgpt_service_account",
       "serviceAccountId": "<service-account-id>"
     }
   }
   ```

5. Deploy the saved Agent and [verify the production Agent](../deploy/production-agents.md#verify-production-workloads).
   For a trusted-proxy gateway, [verify a model response](../operate/model-verification.md).
   Backend credential issuance does not prove the Agent can use it; only a
   real model response verifies that path.

## Verify Backend access

In a shell with Node.js, set `OCC_URL` to the approved HTTPS origin,
`OCC_SERVICE_KEY_FILE` to an owner-readable [OCC service API key file](../http-api.md#set-up-the-connection),
`OCC_NAMESPACE` to the Namespace ID, and `SERVICE_ACCOUNT_ID` to the account ID
from step 3. For a private certificate authority, set `NODE_EXTRA_CA_CERTS` to
its PEM bundle. This command issues a real credential; run it once per account.
It prints only the OCC account ID and credential kind, never the credential.

```bash
: "${OCC_URL:?set the approved HTTPS OCC origin}"
: "${OCC_SERVICE_KEY_FILE:?set the path to the OCC service API key response}"
: "${OCC_NAMESPACE:?set the Namespace ID}"
: "${SERVICE_ACCOUNT_ID:?set the account ID returned by OCC}"
export OCC_URL OCC_SERVICE_KEY_FILE OCC_NAMESPACE SERVICE_ACCOUNT_ID
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";

const origin = new URL(process.env.OCC_URL);
if (origin.protocol !== "https:") throw new Error("OCC_URL must use HTTPS");
const { data: { key } } = JSON.parse(readFileSync(process.env.OCC_SERVICE_KEY_FILE, "utf8"));
if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key)) throw new Error("Invalid OCC service key file");
const namespace = encodeURIComponent(process.env.OCC_NAMESPACE);
const account = encodeURIComponent(process.env.SERVICE_ACCOUNT_ID);
const url = new URL(`/namespaces/${namespace}/service-accounts/${account}/credentials`, origin);
const response = await fetch(url, {
  method: "POST", redirect: "error", body: "{}",
  headers: { "x-api-key": key, "content-type": "application/json" },
});
const body = await response.json().catch(() => ({}));
if (response.status !== 201 || body?.data?.credential?.kind !== "access_token" ||
    body?.data?.id !== process.env.SERVICE_ACCOUNT_ID) {
  const requestId = typeof body?.meta?.requestId === "string" && /^req_[a-z0-9_-]+$/i.test(body.meta.requestId)
    ? body.meta.requestId : "unavailable";
  throw new Error(`Credential issuance was not confirmed (HTTP ${response.status}, request ID ${requestId})`);
}
console.log(JSON.stringify({ id: body.data.id, credentialKind: body.data.credential.kind }));
JS
```

Expect `credentialKind` to be `access_token`. This confirms OCC reached the
ChatGPT admin API, issued a credential for the configured workspace, and stored
it through Kubernetes Compute. If the request times out or returns `409`, use
`GET /namespaces/:namespaceId/service-accounts/:serviceAccountId` with exact
account `read` permission and check for `data.credential.kind: "access_token"`
before trying again. An account can have only one issued credential. GET shows
previously recorded issuance; to verify the route after changing networking,
issue a credential for a new account.

## Troubleshoot

- **`403` from OCC:** check the exact Namespace, account, or Installation
  permission for the operation. Provider-side authorization is separate.
- **`404` from OCC:** check that the account exists in the Agent's exact
  Namespace.
- **`409 RESOURCE_CONFLICT` on deployment:** verify that the account has an
  issued credential from the selected Backend and Driver. Only dedicated Codex
  supports this binding.
- **`503 DEPENDENCY_UNAVAILABLE` when issuing:** confirm that the Installation
  selects the matching ServiceAccount Driver. Have the network operator check
  API Pod DNS and the destination allowed by the NetworkPolicy; also check the
  mounted admin key's workspace and scope, and whether Kubernetes Compute can
  store the credential. Keep the OCC request ID; do not share the key or token.
- **An existing credential stopped working:** expired credentials do not refresh
  automatically; issuing a second credential on the same account returns `409`.
  Create a replacement account, issue its credential, rebind and redeploy
  affected Agents, then delete the old account after nothing references it.
  See [service-account limits](../../reference/service-accounts.md#failures-and-current-limitations).

## Related

- [Backends reference](../../reference/backends.md)
- [Kubernetes Compute](../../reference/drivers/kubernetes-compute.md)
- [Agent model authentication](../../reference/agents.md#harness-authentication)
