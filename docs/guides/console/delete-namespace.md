# Delete a Namespace in the console

Open **Namespaces** and select the trash icon in the Namespace's **Actions**
column. Only an Installation administrator can delete a Namespace: Namespace
IAM Roles cannot grant Namespace `delete`. For other people the icon is
unavailable, and focusing it reads that reason. Ask an Installation
administrator to delete the Namespace. A deny Restriction can also refuse
deletion to an Installation administrator; then the reason names the
Restriction. Ask whoever manages IAM Restrictions to lift it.

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

If the outcome is unknown, select **Refresh status** before deciding to try
again. The Console does not repeat an unconfirmed write automatically. If access
is refused, it reports the access change without claiming deletion succeeded.

If cleanup does not finish, ask an operator to check teardown. After the cause
is resolved, select **Request deletion again** and confirm. The API enforces
the [retry ownership rules](../../reference/namespaces.md#deletion-and-tombstones).
