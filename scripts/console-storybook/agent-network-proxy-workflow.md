# Agent Network proxy workflow

Use **Pages/Create Agent → Gateway channel proxy** to inspect the optional URL
and Secret fields. The label limits the setting to Gateway channel traffic.

Use **Pages/Agent detail → Gateway channel proxy empty** to enter an endpoint,
save it, and inspect the current version. The current version must keep its
saved selection. Deploy the draft to inspect the new revision summary.

Use **Gateway channel proxy saved** to clear the draft selection. Use the
validation, save error, permission, Secrets loading, and Secrets error stories
to inspect each refusal or pending state. Deploy must remain unavailable while
proxy edits are unsaved or the save outcome is unknown.

These stories use simulated API responses. They do not prove persistence,
Secret authorization, Kubernetes enforcement, or a real Gateway connection.
