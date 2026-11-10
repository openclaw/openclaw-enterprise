# Troubleshoot local k3d setup

## Corepack cannot download pnpm through a proxy

Set the approved `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` values for your network. Before the first pnpm command, run `export NODE_USE_ENV_PROXY=1` so Corepack uses those settings. See [Corepack proxy configuration](https://github.com/nodejs/corepack#environment-variables).

## pnpm reports a read-only store

Select a private writable store before retrying the install. Use the run directory printed by the quickstart.

```bash
export pnpm_config_store_dir="${RUN_DIR:?Set RUN_DIR to your private run directory}/pnpm-store"
pnpm install --frozen-lockfile
```

After the install succeeds, continue with the CLI build in [local k3d setup](../deploy/local-setup.md#2-start-a-new-k3d-installation).

## Helm warns that api.trustedProxy is unset

For local password sign-in without a reverse proxy, leave this setting unset. Failed attempts are limited per email. If an HTTP proxy sits in front of the API, [configure proxy trust](../../reference/settings/production.md#github-sign-in-and-trusted-proxies) before using it.
