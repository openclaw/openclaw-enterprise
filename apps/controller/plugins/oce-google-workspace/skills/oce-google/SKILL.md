---
name: oce-google
description: Check the Google Workspace CLI or list one Gmail message reference on the dedicated worker.
---

# Google Workspace CLI

Run `gog --version` on the dedicated worker to check the installation.

If the user asks for a Gmail message and has attached a Google account to this
plugin, run this command on the worker. It returns up to one message ID and thread
ID. An empty list means the account has no matching messages.

```sh
gog --no-input --json --readonly api call gmail v1 gmail.users.messages.list --params '{"userId":"me","maxResults":1}'
```

If no account is attached, ask the user to select one in the Agent’s plugin settings.
