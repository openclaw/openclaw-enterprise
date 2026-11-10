---
name: oce-google
description: Use the managed Google Workspace CLI on the dedicated worker.
---

# Google Workspace CLI

Run `gog` on the dedicated worker. Use `gog schema <command>` to inspect a
command’s arguments, and `--json --no-input` for scriptable output.

For a Gmail account authorized to list message references, use this command.

```sh
gog --json --no-input api call gmail v1 gmail.users.messages.list --params '{"userId":"me","maxResults":10}'
```

An empty list means Google found no matching messages. Commands such as
`gog gmail messages search` may also need permission to read labels and message
metadata. Request message bodies only when the task needs them.

OCE supplies the selected account to the worker. If a request is denied,
report the operation to the user so they can check the account’s allowed API
destination and OAuth scopes in OCE.
