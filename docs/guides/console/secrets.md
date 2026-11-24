# Manage Secrets in the console

Open **Credentials** in the sidebar. The **Secrets** tab opens first. Select a Namespace. Search by name or ID,
or select **Refresh** to reload metadata. The list contains only Secrets you may
read. Values are never returned. A ready Namespace is required to create or
replace a value; ask an administrator for the exact operation permissions.
Without Secret `create` in the Namespace, **Create Secret** is disabled and a
note under it says so.

## Register a Google OAuth client

As an Installation administrator, open **Credentials → OAuth clients → Register OAuth client** and select the Installation-wide **Google OAuth** template. Register the displayed redirect URI with Google, then enter the client ID and secret that Google issued.

To change where the account can send requests, open **Connection templates → Edit Google OAuth** and expand **API destinations**. The Namespace selector on either tab shows Installation-wide entries alongside those available in the selected Namespace. [Connection templates](../../reference/connection-templates.md)

When you edit a saved manual template, add only hosts you trust to receive existing accounts’ access tokens.

## Create and use a Secret

1. Select **Create Secret** and enter a unique name and value. Names cannot be
   changed after creation. The value is masked; **Show value** reveals only the
   material you entered. Multiline values use LF line endings. Browsers without
   multiline masking support offer a single-line password field and reject
   pasted line breaks.
2. Select **Create Secret**, then close the success message. The value is cleared
   after the request and is never stored in browser storage.
3. Open Agent creation or its **Credentials** tab and select the Secret by name.
   Creating or reading a Secret does not grant permission to use it. Follow
   [Secret binding permissions](../topics/secrets.md#create-and-bind-a-secret).

## Inspect consumers

Select a Secret name to read its ID and current consumers. Agents found in the
subsequent readable Agent list show by name, with their IDs, and link to their
console pages. If an Agent is no longer listed, its row omits the identity and
asks you to reopen the Secret to check again. This does not establish why it is
absent. Configurations, CredentialSources, and pending provisioning
requests show their IDs; manage those references through their supported APIs or
CLI commands. Hidden consumers appear as a count, and incomplete results are
marked. Ask an administrator to inspect references you cannot read.

A Secret link on an Agent page opens that Secret here, also when you must sign
in first. A link to a Secret that is not in your list opens nothing. A note says
the Secret may not exist or you may not read it.

## Replace a value

If the credential is exposed, revoke it at the provider immediately and stop
affected workloads. To rotate related channel Secrets together, stop their
Agents and wait for shutdown before changing any value.

Select the Secret, then **Replace value**. Enter the replacement and confirm.
The ID and bindings remain stable. The old value is never loaded into the form.
Without Secret `update` on it, **Replace value** is disabled and the dialog says
so; without Secret `delete`, **Delete Secret** is too.

A successful save changes the stored value.

For a Secret-backed CredentialSource, follow
[Update a source](../../reference/credential-sources/other-delivery-modes.md#update-a-source).
Update a static Credential Gateway copy first. Review drafts and redeploy only
Agents intended to run. For
direct model, channel or proxy credentials, follow
[Update and redeploy](../../reference/drivers/kubernetes-secret.md#update-and-redeploy).
For routine rotation, verify that running consumers use the replacement before
revoking the old credential.

## Delete and recover

Open an unreferenced Secret, select **Delete Secret**, and confirm **Permanently
delete Secret**. Deletion cannot recover the stored value. It does not revoke the
credential at its provider or erase values already delivered to workloads.

Known references disable deletion. The API checks again when deletion is
submitted, so a concurrent reference can still block it. Close and reopen the
Secret to inspect current consumers, remove the references at their owners,
then review a new confirmation.

A permission refusal clears the entered value and disables submission. Ask an
administrator for access, then refresh. Storage failures show a request ID when
available. An **Outcome unknown** message means the write may have applied:

- After creation, close the form and refresh the list. A missing name does
  not prove the write failed. Ask someone with read access to check that
  Namespace before creating another Secret.
- After replacement, check which credential the consumer used, for example
  by its ID at the provider. A consumer can still hold an older copy. Metadata or a
  successful request alone cannot confirm replacement. If you cannot tell
  which credential was used, leave the outcome unresolved.
- After deletion, use **Check deletion status**. A failed or denied read cannot
  confirm removal.

Requests are never automatically repeated. Pending requests block dismissal and
in-console navigation. Closing a form, changing pages, or session expiry clears
entered material.
