# Agent Network proxy workflow

Open **Pages/Create Agent → Gateway channel proxy**. Enter an HTTP or HTTPS
endpoint without credentials in the URL. If the proxy requires Basic
authentication, focus **Proxy credential** to load the Source list. Select
**Channel proxy credential (simulated)** or choose **Add new credential…** to
create a static Credential Source. Select **Create Agent**, then inspect the
saved endpoint and Source ID on the draft.

Open **Pages/Agent detail → Gateway channel proxy empty** to update an existing
Agent. Select **Save Network proxy for next deployment**. The draft displays
the new endpoint and Source ID. Open the current version to check its
saved selection, then deploy from the draft to inspect the new version.

In both forms, set the viewport to 360 px and the browser's minimum font size
to 24 px. The Basic authentication example should fit inside the field without
horizontal scrolling. Selecting it should preserve `Basic <base64(username:password)>`.

Use **Gateway channel proxy saved** to clear the draft selection. The Sources
loading and Sources error stories show a pending or unavailable list. The
validation, save error, enforcement unavailable, and permission stories show
why the editor refuses an action. Deploy stays unavailable while proxy edits
are unsaved or the save outcome is unknown.

These stories use simulated API responses. Verify persistence, Source
authorization, Kubernetes enforcement, and Gateway traffic separately.
