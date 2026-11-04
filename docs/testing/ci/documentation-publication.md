# Publish private documentation

## Overview

This workflow validates published OpenAPI examples, builds documentation and its
search index, and deploys `dist/docs/` to private GitHub Pages. It is a publication
workflow, not a product test suite.

## When it runs

Every push to `main` starts the workflow. Manual dispatch is also available, but
the deployment job runs only on `refs/heads/main`. The `github-pages` environment
controls deployment. Runs share the `pages` concurrency group and do not cancel
an active run.

Failure prevents that documentation deployment. It does not fail the PR merge
gate or prove a problem with Agent runtime behavior.

## Scenarios

These are validation and publication stages rather than runtime test scenarios.

| Setup and action                                                         | Expected outcome                                                                                   | Source                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Install the pinned documentation dependencies and lint OpenAPI examples. | The OpenAPI lint command accepts the published contract and examples.                              | [`openapi:lint`](../../../package.json) and [Redocly configuration](../../../scripts/docs-site/redocly.yaml). |
| Build the Markdown site and Pagefind index.                              | Navigation and local links resolve; rendered pages and search assets are produced in `dist/docs/`. | [Site builder](../../../scripts/docs-site/build.mjs) and [`docs:build`](../../../package.json).               |
| Upload the site artifact and deploy through the Pages action.            | The deployment step reports a site URL for the uploaded build.                                     | [Publication workflow](../../../.github/workflows/docs-pages.yml).                                            |

## Run it

Before enabling publication, follow the
[private Pages setup](../../local-preview.md#publish-privately-with-github-pages).
A private repository alone does not establish private Pages visibility.
For environment, domain, and access setup, use
[documentation hosting](../../contributing/documentation-hosting.md).

To publish the current `main` after setup:

```sh
gh workflow run docs-pages.yml --ref main
```

For a local build, follow [preview and validation](../../local-preview.md).
`docs:build` does not replace `docs:check` or the required visual inspection for a
documentation change.

## Results and limits

Check **Validate published OpenAPI examples**, **Build documentation and search
index**, and **Deploy private documentation**. Open the deployment URL as a
repository reader and verify a deep page and search. Deployment success alone
does not prove the navigation is usable or access is restricted correctly.

If publication fails, inspect the failed step, correct the source or hosting
configuration, and rerun from `main`. This workflow runs no Agent runtime tests
and has no test-lane manifest.

## Files

- [Workflow](../../../.github/workflows/docs-pages.yml): triggers, permissions, environment, build, and deployment.
- [Navigation](../../docs.json): menus, sidebars, and registered pages.
- [Site builder](../../../scripts/docs-site/build.mjs): Markdown rendering and link validation.
- [Package scripts](../../../package.json): OpenAPI lint and docs build commands.
- [OpenAPI contract](../../../packages/contracts/openapi/occ-api.openapi.json): published API source.
