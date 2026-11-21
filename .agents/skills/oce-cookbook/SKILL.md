---
name: oce-cookbook
description: Run OpenClaw Enterprise maintenance recipes. Use only when deliberately invoked.
dependencies: [enterprise-testing, local-dev]
---

# OCE cookbook

Use only when the user deliberately invokes `oce-cookbook` or `$oce-cookbook`.
Do not activate this skill merely because a request mentions a maintenance task.
Use it from an OpenClaw Enterprise (OCE) checkout.

## Recipes

- `update-openclaw-pin <ref>`: update the pinned OpenClaw source and qualify the
  resulting images. Read [Update the pinned OpenClaw source](./references/update-openclaw-pin.md).

For example: `$oce-cookbook update-openclaw-pin <reviewed-commit-or-tag>`.
Read only the selected recipe. If no recipe is selected and the intended operation
is unclear, list the available recipes and ask which one to run. Respect the
request's scope; editing or explaining this skill does not execute a recipe.

Keep each future recipe in `./references/<recipe>.md` and add it to this list.
