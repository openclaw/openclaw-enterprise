# Delete a Namespace in the console

Open **Namespaces** and select the trash icon in the Namespace's **Actions**
column. Deletion requires Namespace `delete` on that Namespace. An
[Installation-configured Role](../../reference/authorization/default-users.md)
can grant it, for example through an Owner binding on a Namespace the person
created. The Namespace IAM API cannot grant Namespace `delete`.

If the icon is unavailable, focus it to read the reason. Ask an Installation
administrator to check your access. If you administer the Installation, check
the grant and any IAM Restrictions. The permission check alone cannot establish
the cause. The deletion request rechecks access and can also refuse Preset cleanup.

1. Check the name and ID in the confirmation. Deletion cannot be undone, and
   the name remains reserved. Unchanged, automatically added Presets are removed
   with the Namespace, which also requires Preset `delete` permission.
2. Select **Delete Namespace**. **Cancel** or Escape closes the confirmation
   before submission. While the request is pending, wait for its result.
3. If the Namespace still contains resources, the dialog names the remaining
   kinds and the IDs that you can read, and counts the others. **View Agents** and **View Secrets** open that Namespace's
   resources. Expand **Configuration cleanup commands** to remove unused
   Configurations after their Agents are gone. Other resource kinds need their
   CLI or API operations. See [deletion requirements](../../reference/namespaces.md#deletion-and-tombstones).
4. After acceptance, the row shows **Deleting…**. Cleanup continues in the
   background. The Console checks status every three seconds while the page is
   open; **Refresh status** checks immediately. When removal is confirmed, the
   row disappears and a success message appears. If it was selected, the Console
   chooses another readable Namespace, or clears the selection when none remain.

If a status check fails, the confirmation closes. An invalid response shows
**Could not check deletion status**. An unconfirmed status or write shows a
warning **Status unknown** badge and hides both deletion actions. Select
**Refresh status**; a successful check restores the confirmed badge and lets
you open a new confirmation if deletion is still available. The Console never
repeats an unconfirmed write automatically. If access is refused, it reports the
access change without claiming deletion succeeded.

If cleanup does not finish, ask an operator to check teardown. After the cause
is resolved, select **Request deletion again** and confirm. The API enforces
the [retry ownership rules](../../reference/namespaces.md#deletion-and-tombstones).
