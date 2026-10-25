# Manage Secrets in the console

Open **Secrets** in the sidebar and select a Namespace. Search by name or ID,
or select **Refresh** to reload metadata. The list contains only Secrets you may
read. Values are never returned. A ready Namespace is required to create or
replace a value; ask an administrator for the exact operation permissions.
Without Secret `create` in the Namespace, **Create Secret** is disabled and a
note under it says so.

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

Select a Secret name to read its ID and current consumers. Agent IDs link to their
console pages. Configurations, CredentialSources, and pending provisioning
requests show their IDs; manage those references through their supported APIs or
CLI commands. Hidden consumers appear as a count, and incomplete results are
marked. Ask an administrator to inspect references you cannot read.

## Replace a value

Select the Secret, then **Replace value**. Enter the replacement and confirm.
The ID and bindings remain stable. The old value is never loaded into the form.

A successful save changes storage. Deploy consuming Agents again through OCE
and verify credential use. CredentialSources hold a separate copy; follow
[source updates](../../reference/credential-sources.md#update-a-source) as well.
See [Update and redeploy](../../reference/drivers/kubernetes-secret.md#update-and-redeploy)
for delivery and revocation requirements.

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

- After creation, close and refresh the list before deciding to create another.
- After replacement, verify credential use before deciding to submit another
  replacement; metadata cannot confirm the stored value.
- After deletion, use **Check deletion status**. A failed or denied read cannot
  confirm removal.

Requests are never automatically repeated. Pending requests block dismissal and
in-console navigation. Closing a form, changing pages, or session expiry clears
entered material.
