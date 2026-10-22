# Test Agent OAuth connections locally

Start a disposable k3d stack that can hold
[Agent OAuth connections](../../reference/connection-templates.md), then connect
a Google account to a personal Agent with the
[Gmail guide](google-gmail-connection.md). This profile is for development only.

## Choose the console origin

OCC derives the callback URI from the console origin, and the Google client must
accept it:

| Console                      | Callback URI                                             | Google client       | Agent chat                         |
| ---------------------------- | -------------------------------------------------------- | ------------------- | ---------------------------------- |
| Loopback HTTP (default)      | `http://127.0.0.1:3000/oauth/callback`                   | **Desktop app**     | None for OpenShell Agents          |
| HTTPS under a browser domain | `https://console.<cluster>.<domain>:8443/oauth/callback` | **Web application** | [Native admin UI](native-admin.md) |

Google refuses redirect URIs under `.localhost`. For the HTTPS console, set
`OCC_DEVELOPMENT_BROWSER_DOMAIN` to a registrable domain whose names all resolve to
`127.0.0.1`, such as `localtest.me`. Startup refuses the domain unless the console
and Agent host names resolve only to loopback. Fix the cluster name so the callback
URI stays the same across rebuilds.

The owner of a third-party domain such as `localtest.me` can change its DNS and
obtain public certificates for its names, then receive your console cookies and
OAuth codes. Use such a domain only with test accounts; prefer a domain your team
controls.

## Start the profile

Meet the [Kubernetes-only profile prerequisites](local-kubernetes-development.md#start-the-profile).
Use a fresh state directory. Startup downloads `gog` from GitHub.

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_CONNECTIONS=openshell
# Optional: the HTTPS console and native admin UI.
export OCC_DEVELOPMENT_BROWSER_DOMAIN=localtest.me
export OCC_DEVELOPMENT_KUBERNETES_CLUSTER=occ-dev-gmail
./scripts/dev-up
```

Expected result: the ready message also prints:

```text
Agent OAuth connections: enabled
  Callback URI: https://console.occ-dev-gmail.localtest.me:8443/oauth/callback
  Client Workspace: oce-oauth-clients
  Connection tool: /usr/local/bin/gog (gog 0.36.0)
```

For the HTTPS console, import the printed browser CA certificate into your browser.
Startup refuses `OCC_DEVELOPMENT_CONNECTIONS` and `OCC_DEVELOPMENT_BROWSER_DOMAIN`
with the Compose control plane.

## What the profile configures

| Component                 | Setting                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenShell gateway         | HTTPS from a private development CA. A client certificate with `OU=operator` grants gateway administration. Sandboxes still authenticate with gateway-issued tokens; other OCC calls send no token, so NetworkPolicy remains their boundary.            |
| OpenShell Backend         | `https` endpoint, `rootCertificatePath`, and `operatorTls` from the Secret `openclaw-openshell-tls`, mounted at `/etc/openclaw/openshell-tls`.                                                                                                          |
| Credential Refresh Driver | `clientWorkspace: oce-oauth-clients`. Startup creates that Workspace and its Kubernetes namespace.                                                                                                                                                      |
| API egress                | TCP 443 to any address except `169.254.0.0/16`, for the callback's code exchange.                                                                                                                                                                       |
| Runtime image             | `openclaw-enterprise-runtime:connections` trusts the CA, so Agent Gateways reach sandboxes over HTTPS. It adds `gog` 0.36.0 at `/usr/local/bin/gog`, checked against the release SHA-256. The Credential Gateway's `toolBinaries` lists only that path. |

The CA, certificates, and keys stay in the state directory for three months.
`dev-down` deletes them with the cluster.

## Create the Google client

Follow [Create the Google OAuth client](google-gmail-connection.md#create-the-google-oauth-client)
with these local differences:

- Choose the client type from the table. A **Desktop app** accepts the
  `http://127.0.0.1` loopback redirect without registering it. A **Web
  application** needs the printed callback URI as an authorized redirect URI.
- In **Testing** mode, add each Google account that will connect as a test user.
- Save the downloaded JSON with mode `0600` outside the repository. Do not paste it.

## Connect and check

Continue the [Gmail guide](google-gmail-connection.md#create-the-connection-template)
with `OCC_URL=http://127.0.0.1:3000`, the loopback API, for either console. Locally, you can create and share the
template with the CLI and the service key file that startup prints, instead of
an administrator session:

```bash
export OCC_URL=http://127.0.0.1:3000
export OCC_SERVICE_KEY_FILE=<service key file>
./bin/occ connection-template create --file "$PRIVATE_DIR/template.json"
./bin/occ connection-template bind <templateId> --namespace <namespaceId>
```

Sign in to the console that startup prints as the person who connects, and
start the connection from that tab. After the callback, that person must deploy
the Agent: a connected Agent refuses deployment by anyone else, including the
service key.

The OpenShell gateway logs `provider credential refresh completed` with
`credential_key=GOG_ACCESS_TOKEN` after the first token is issued.

## Read mail from the native admin UI

With a browser domain, before you connect the account, add the native admin
policy to the Agent's Configuration as described in
[Configure each Agent](native-admin.md#configure-each-agent), and remove any
`tools.deny` entry that blocks shell commands. Connect, then deploy. On the Agent
page, open **Native admin UI** and ask the Agent to run one bounded command, such
as `gog --readonly gmail search 'in:inbox' --max 3 --json`.

Gmail allows each user 250 quota units per second, and `gog` fetches every search
result in parallel. An unbounded search can exceed that limit, and Gmail then
answers `403 rateLimitExceeded` for a few minutes. Wait, then retry with a small
`--max`.

## Limits

- Without a browser domain, this profile serves no browser chat for OpenShell
  Agents, so the console cannot ask the Agent to run `gog`.
- `scripts/first-agent.mjs` Agents deny all tools until you remove `tools.deny`
  from their Configuration.
