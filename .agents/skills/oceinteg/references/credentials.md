# Supply credentials for the main scenario

Read this before retrieving credentials for `oceinteg main`. Reuse the user's
named credential items or protected files. Ask for missing references and field
names, never for secret values in chat. Do not access credentials merely to edit
or validate this skill.

## Identify the required fields

Keep the actual references in an operator-local input record outside the
repository and evidence directory. Record only purpose, selected account, and
completion status in shared reports.

| Purpose           | Required input                                                                                                  | Destination                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Agent model       | Existing Codex-scoped service-account token and selected model                                                  | Namespace Secret selected under Console **Service Accounts**               |
| Slack Socket Mode | App-level token (`xapp-` prefix)                                                                                | Namespace Secret selected as **Slack app token**                           |
| Slack bot         | Bot token (`xoxb-` prefix) from the same Slack app/workspace                                                    | Namespace Secret selected as **Slack bot token**                           |
| GitHub broker     | App ID, installation ID, both numeric repository IDs, and RSA private-key reference/file                        | Operator-owned broker registry and Kubernetes input Secrets                |
| Linear            | Authorized account/workspace, known readable issue, and any provider connection required by the selected plugin | Supported account connection; never raw credentials in Agent Configuration |

An item name alone does not identify which field to use. A Slack item may contain
both tokens; do not use its app-level token for the bot field. Do not confuse an
OCC operator service key, a 1Password service-account token, or a refresh token
with the Agent's Codex service-account token.

## Retrieve without exposing values

Use an existing authenticated secret manager. For 1Password, check `op --version`
and `op whoami`; if access is unavailable, ask the operator to unlock/sign in.
Do not create a new credential or change accounts implicitly.

If only an item name is supplied, inspect field metadata with values excluded
before output reaches the transcript:

```bash
op item get "$ITEM_NAME" --vault "$VAULT_NAME" --format json |
  jq '[.fields[] | {id, label, type, reference}]'
```

Resolve each required field to its `op://<vault>/<item>/<field>` reference. Keep
real item names and references private. Do not run an unfiltered item dump,
bare `op read`, shell tracing, or environment dumps.

For Console entry, prefer the password manager's autofill or direct paste into
the masked Secret field. If automation cannot transfer a value without recording
it in tool arguments or output, have the operator enter it directly in that
field. Never ask for it in a chat message. Capture screenshots only after secret
dialogs are closed.

When the broker installer needs a private-key file, export directly to a new
protected file instead of stdout. `GITHUB_APP_KEY_REF` contains a secret
reference, not the key. `OCC_INPUT_DIRECTORY` is the operator's private
installation-input directory outside the repository.

```bash
umask 077
install -d -m 700 "$OCC_INPUT_DIRECTORY/repositories"
test ! -e "$OCC_INPUT_DIRECTORY/repositories/private-key.pem"
op read "$GITHUB_APP_KEY_REF" --file-mode 0600 \
  --out-file "$OCC_INPUT_DIRECTORY/repositories/private-key.pem"
```

An existing protected file can be used directly; do not overwrite or rotate it.
Do not export model or Slack values to a file just to read them back into chat.

## Bind model and Slack credentials through Console

Follow the current [Console creation flow](../../../../docs/reference/console/create-and-deploy.md)
and [Credentials tab](../../../../docs/guides/console/agent-details.md#credentials-tab).

1. Sign in as an authorized operator and select the intended OCE Namespace.
   In **Create Agent**, apply **Community Agent**, choose **OpenAI** and
   **Codex**, and select **Service Accounts** as the authentication method.
2. In the model credential picker, select an existing appropriate Namespace
   Secret or **Create new Secret...**. Give a new Secret a run-scoped name such
   as `integ-model-<run-id>`, enter the service-account token in its masked
   value field, save, and select it. Choose the intended model explicitly.
   Creating the Secret persists it even if Agent creation is cancelled.
3. Open the Slack channel card. For **Slack app token** and **Slack bot token**,
   select existing appropriate Secrets or create separate run-scoped Secrets
   through each picker. Enter the app and bot tokens in their respective masked
   fields. Select the exact test channel and **Apply channel settings** before
   leaving the drawer.
4. If binding after Agent creation, use **Credentials** → **Service Accounts**
   and **Save authentication source** for the model. Use **Channel Secrets** →
   the two Slack pickers → **Save channel Secrets** for Slack, then explicitly
   deploy the saved changes through Console.
5. Verify saved references and grants, not displayed values. If a grant failed,
   use the supported **Retry credential access** control after an authorized
   administrator resolves the exact permission through Console. If the binding's
   save outcome is unknown, reload it before retrying. Do not patch IAM tables or
   Secrets through an API to make this scenario pass.

Require a real model response and a real Slack event/reply after deployment.
A saved binding or **Bound** badge does not prove provider acceptance.

## Supply the optional broker inputs

For the omitted-broker case, leave the capability disabled and provide no App
key. For the configured case, follow the
[broker installation guide](../../../../docs/guides/repository-credentials/installation.md).
This operator installation step is separate from Console-only Agent provisioning.

Bootstrap OCC first to obtain its server-assigned Namespace IDs. Build the
registry with the supplied App/installation/repository IDs and the scenario's
approved profiles. Prepare the service configuration and certificate/key/CA
files using the rendered broker hostname.

Create the operator-owned registry ConfigMap and service/App/TLS/public-CA
Secrets through the guide's file-based commands. Use `--from-file` for protected
inputs, never `--from-literal` containing a credential. Chart values and
Installation configuration carry Secret names and file references, not private
key contents. Keep the TLS private key separate from the public CA input. Verify
broker startup and trust before choosing the Agent's repository bindings in
Console. Never mount the App key into the Agent.

## Authenticate Linear and handle failures

In **Configure plugins**, select Linear from the curated catalog. Curated
discovery needs no discovery token, but it does not grant Linear account access.
Save the selection and deploy through Console.

Use an already authorized account connection or the selected version's supported
user-visible provider login/consent flow. Verify the intended Linear workspace
and read-only access with a real lookup of the chosen issue. Do not invent a
Linear-token field or inject a PAT into native Configuration: plugin-specific
credential APIs are outside the current
[plugin configuration contract](../../../../docs/reference/agent-plugins.md).

If startup reports `PLUGIN_AUTH_REQUIRED`, record the required account action.
If that action has no supported user-visible path, mark Linear acceptance blocked
rather than patching runtime credential files. Similarly, model quota/authentication
or Slack membership failures block their checks; do not silently substitute
another account.

During cleanup, remove only temporary exports and run-created Secrets whose
ownership and lack of remaining consumers are verified. Preserve preexisting
credential items and shared Secrets. Never include credential values or private
input files in the evidence bundle.
