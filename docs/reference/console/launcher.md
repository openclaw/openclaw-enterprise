# Workspace launcher

Open `/console/launch` to reach your assigned Claw. After sign-in, OCE opens the
only available destination automatically. If you have several destinations,
choose one by name. **Fleet administration** appears only with Installation
`administer`; it does not imply access to every Agent. A Claw needs readable
Namespace and Agent access and exact Agent `administer` permission.

Signing in without a supported destination also opens the launcher. This
includes signing in at `/console/login` and signing back in after **Sign out**.
A supported console page that sign-in interrupted, such as an Agent link,
still opens that page after authentication.

An assigned workspace that is stopped, disabled, unsupported, or unavailable
stays visible without an open link. Use **Refresh availability** to check again.
A failed discovery offers **Try again**, not a partial list or an automatic
redirect. **No access assigned** means discovery completed without any permitted
destinations; contact your administrator. Availability describes native UI
configuration and version state, not a live gateway health probe.

Use **Switch destination** in the console account menu to open
`/console/launch?choose=1`, which never opens a destination by itself. Existing
`/console/` and resource deep links keep their meaning. Operators can point
their entry URL at `/console/launch` after verifying it in their environment;
the controller does not reconfigure an external ingress redirect.

The launcher uses the current session and permission APIs without a separate
permission store, saved default, or service credential. It does not grant access
or change an external access gateway's sign-in policy. Opening a native Agent
host without a valid session follows the existing
[Agent recovery](../agent-native-admin.md): sign-in ends at that Agent's console
page, not the launcher.

## Visual review

The **Pages/Launcher** Storybook group covers sign-in, chooser, unavailable, empty,
error, and loading states. Use example credentials only; the native destination
is simulated. Browser tests separately exercise the real session and IAM APIs.

For administration, see the [platform console](../console.md).
