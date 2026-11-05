# Operate documentation hosting

Keep the documentation private until the team explicitly approves public access.
The source repository stays private when the documentation becomes public.
Merging documentation changes or running the deployment workflow does not change
the site's visibility.

## Deploy private documentation

In repository **Settings → Pages**, select **GitHub Actions** as the source and
confirm visibility is **Private** before publishing. A private repository alone
does not make a Pages site private. Restrict the `github-pages` environment to
`main`. Pull requests must pass normal review and merge requirements before
their content is published.

The [documentation workflow](../../.github/workflows/docs-pages.yml) runs after
every push to `main`. Manual dispatch is also available; deployment runs only on
`refs/heads/main`. From the repository root, publish the current `main` with:

```sh
gh workflow run docs-pages.yml --ref main
```

Runs share the `pages` concurrency group and do not cancel an active run. The job
grants `pages: write` and `id-token: write`; no deployment secret, model
credentials, controller services, or Cloudflare credential is needed. A custom
domain is optional.

### Build and deployment stages

The workflow installs the pinned documentation dependencies, then:

1. **Validate published OpenAPI examples** runs `openapi:lint` against the
   published contract and examples.
2. **Build documentation and search index** runs `docs:build`. Navigation and
   local links must resolve; the Markdown site and Pagefind index go to `dist/docs/`.
3. **Upload documentation** and **Deploy private documentation** publish that
   directory through GitHub Pages and report the deployment URL.

Failure stops that documentation deployment. This workflow is outside the PR
merge gate, runs no Agent runtime tests, and has no test-lane manifest.
For local work, follow [preview and validation](../local-preview.md).
`docs:build` does not replace `docs:check` or visual inspection.

### Verify a deployment

After a successful run, open the URL from its Actions summary or **Settings →
Pages** as a repository reader. Check a deep page, search, and an interactive
matrix. A successful deployment alone does not establish usable navigation or
correct access restrictions. If publication fails, inspect the failed step,
correct the source or hosting configuration, and rerun from `main`.

### Configure and verify the domain

The custom domain is `docs-enterprise.openclaw.org`. Its DNS record is
`docs-enterprise CNAME openclaw.github.io` in the `openclaw.org` zone. The zone is
managed in Vercel; preserve its other records. GitHub Actions publishing does
not require a repository `CNAME` file. See GitHub's
[custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

Use an authenticated GitHub CLI session to inspect the current state:

```sh
gh api repos/openclaw/openclaw-enterprise/pages \
  --jq '{cname, public, https_enforced, https_certificate}'
gh run list --repo openclaw/openclaw-enterprise \
  --workflow docs-pages.yml --branch main --limit 3
```

The ready private state has the expected custom domain, `public: false`, a valid
certificate for that domain, and `https_enforced: true`. A signed-out request
must reach GitHub authentication. A reader with repository access should be able
to open the home page, `/guides/quickstart`, and search. An authentication redirect
alone does not prove that the rendered documentation works.

GitHub can reset HTTPS enforcement when a custom domain changes. If the
certificate is absent, check Pages DNS health and wait for issuance; do not
disable privacy or bypass TLS verification. Once the certificate works, restore
enforcement and read the settings back:

```sh
gh api --method PUT repos/openclaw/openclaw-enterprise/pages \
  -F https_enforced=true
```

### Publication source files

- [Workflow](../../.github/workflows/docs-pages.yml): triggers, permissions,
  environment, build, and deployment.
- [Navigation](../docs.json): menus, sidebars, and registered pages.
- [Site builder](../../scripts/docs-site/build.mjs): Markdown rendering and link validation.
- [Package scripts](../../package.json) and [Redocly configuration](../../scripts/docs-site/redocly.yaml):
  OpenAPI lint and documentation build commands.
- [OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json): published API source.

## Approve public launch

Public access is a separate maintainer action, not a deployment side effect.
Before authorizing it, review the generated site's contents, including hidden
navigation pages and search results: hidden pages are still published. Record
the approved deployment commit and team approval in the launch PR or issue.
Confirm the latest successful documentation deployment is that reviewed commit,
the repository is still private, and the domain has working enforced HTTPS.

An authorized maintainer or agent can then run this explicit launch command:

```sh
gh api --method PUT repos/openclaw/openclaw-enterprise/pages -F public=true
```

Read the Pages state back with the inspection command above and confirm
`public: true`, the same domain, and HTTPS enforcement. Verify the home page,
deep links, assets, and search in a signed-out browser. Future pushes to `main`
continue updating the now-public documentation. Repository visibility is unchanged.

The same switch is available in repository **Settings → Pages → GitHub Pages
visibility**. The [Enterprise Cloud Pages API](https://docs.github.com/en/enterprise-cloud@latest/rest/pages/pages#update-information-about-a-github-enterprise-cloud-pages-site)
supports the `public` field; fine-grained credentials need **Pages: write** and
**Administration: write**. The deployment workflow's `GITHUB_TOKEN` does not have
the administration permission needed for this settings change. Keep the launch
step outside routine CI; a future CI toggle needs a separately approved privileged
credential and approval gate.

To restore private access, use the same authorized account:

```sh
gh api --method PUT repos/openclaw/openclaw-enterprise/pages -F public=false
```

Confirm `public: false` and that signed-out page and asset requests require
authentication again. This does not revoke copies downloaded while the site was
public.

## Move hosting to Cloudflare later

Reuse the existing `npm run docs:build` output in `dist/docs`; no renderer change
is needed for static hosting at the domain root. Configure and verify access
protection before uploading private documentation to another host: GitHub
repository authorization does not transfer with static files. Check the home
page, deep links, assets, and search on the protected target before switching
the domain. Treat hosting migration and public launch as separate decisions.
