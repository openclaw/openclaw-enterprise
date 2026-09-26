# Local platform development

Set up a checkout to change the control plane, console, CLI, or Drivers. The
[first-change walkthrough](first-change.md) edits and runs CLI help without a
database, controller, or account.

## Prepare the checkout

You need access to the private repository, Git, Node.js 24 or newer, the pnpm
version pinned in [`package.json`](../../package.json), and the Go version in
[`go.mod`](../../go.mod). In a clean checkout, install the pinned dependencies:

```sh
pnpm install --frozen-lockfile
```

This sets up the repository's pre-push hook unless a custom hook configuration
prevents it. Read the [checkout and hook policy](../../CONTRIBUTING.md#set-up-a-development-checkout)
before changing shared dependencies or hook configuration.

## Run the platform when your change needs it

- [Local Setup](../guides/quickstart.md) starts the local Kubernetes platform and
  leads to deploying an Agent.
- [Local Kubernetes development](../guides/deploy/local-kubernetes-development.md)
  covers the contributor profile and health checks. Once it is running, use the
  [edit and rebuild loop](../guides/deploy/local-kubernetes-development.md#rebuild-after-a-source-edit)
  to reload the API, worker, or console without resetting PostgreSQL or the
  Kubernetes cluster. The console is served by the controller.
- [Testing](../testing/README.md) covers isolated PostgreSQL, Docker, Kubernetes,
  and browser checks. Use the environment required by the behavior you changed.
- [OpenShell tests](../testing/openshell.md#start-a-reusable-development-environment)
  provide an owned, reusable v0.1.0 cluster for Sandbox Driver development and
  its real model and containment proof. It is separate from the normal
  fail-closed OpenShell development profile and does not make OpenShell a
  supported production Agent runtime.

## Choose checks for your change

Use [local checks](../testing/local.md) for linting, formatting, types, and
focused code checks. New platform functionality also needs integration coverage
through the workflow that uses it; the [integration guide](../testing/README.md#integration-tests)
lists suites and required infrastructure. The [CI guide](../testing/ci.md)
explains which checks run on pull requests.

For documentation or docs-site presentation changes, use the [documentation
checks](documentation.md#preview-and-check); do not add or run tests for those
changes. Follow the [pull request policy](../../CONTRIBUTING.md#prepare-a-pull-request)
and record the checks you ran, including anything skipped or unavailable.
