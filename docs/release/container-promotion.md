# Docker Hub promotion

[`container-promote.yml`](../../.github/workflows/container-promote.yml) copies the exact
controller and runtime digests already published by
[Enterprise Containers](containers.md). It never builds images, creates a
repository, changes visibility, or falls back to an alternate destination.

Promotion requires an ordinary successful publication from the public Enterprise
source repository to public GHCR packages. The Docker Hub destinations remain
private and separately authorized. No-push preparation with `PUBLISH=false` does
not create a promotion source.

## Operator setup

Complete the [publication configuration](configuration.md#publication-configuration),
including the separately authorized private Docker Hub destinations and scoped
credentials. That page owns the environment, variable, and secret requirements.

The workflow checks Docker Hub's authenticated namespace-scoped repository API
for exact identity and `is_private: true` before any image transfer. A missing
repository, inaccessible API, public visibility, or conflicting source tag fails
closed. No private-code bootstrap is attempted.

## Promote

1. Merge the reviewed promotion workflow to `main`.
2. From a successful GHCR publication, record its full source SHA, run ID, and
   exact attempt. Its publication receipt must still be retained.
3. Under an explicit publication request, manually dispatch **Promote Enterprise
   Containers to Docker Hub** on `main` with those three inputs after checking
   the producer, destinations, and
   [GHCR package linkage](containers.md#confirm-package-linkage).
4. Use the digest references in the job summary. Skopeo copies from GHCR by digest
   with `--all --preserve-digests`; the copied digest is verified at Docker Hub.
   Existing identical tags are left unchanged; conflicting tags are rejected.

Source must be in the selected main workflow's history and retain successful
exact CI. The receipt's base digest must still match `CONTAINER_NODE_BASE_IMAGE`.
The two images are not an atomic transaction. Inspect the remote digests after
partial failure; do not remove or replace tags automatically.

Local contract checks: `node --test tests/integration/container-promote.test.mjs`.
These tests do not authenticate to either registry or prove a live transfer.

## Verify the served Console

After approved promotion and traffic selection, run this read-only command on a
POSIX host with Python 3 and Git supporting `--no-lazy-fetch`. Set
`CONTROLLER_SOURCE_SHA` to the full lowercase source commit from the receipt for the **controller image actually routed to
users**. Supply a local repository containing it and the HTTPS URL users open.
For a runtime-only upgrade, skip this check unless confirming the unchanged
controller with its previous receipt and previous SHA. Source objects must already
exist locally: missing objects in partial clones return `invalid-source`; the
verifier never fetches them.

```bash
umask 077
python3 scripts/verify-console-release.py /secure/src/openclaw-enterprise \
  "$CONTROLLER_SOURCE_SHA" 'https://console.example.com/console/' \
  > "$UPGRADE_EVIDENCE/console-verification.json"
```

Keep the result with the private publication and upgrade evidence. Exit zero
(`verified`) proves one delivered build marker and base CSS against that commit;
it records the revision and CSS SHA-256. Theme colors remain installation-owned.

The check supports the existing release shell, including `renderConsoleThemeShell`
output: an explicitly closed head containing the marker and the plain
`<link rel="stylesheet" href="/console/console.css">`. Inert markup, extra attributes
on that link, or malformed placement leave identity unverified. Both responses
must have exactly one valid, bounded `Content-Length` and one `Content-Type`
(`text/html` or `text/css`, respectively), with no parameters except optional
`charset=utf-8` (quoted or unquoted). Chunked or close-delimited responses,
incompatible or ambiguous content types, and compression return
`unexpected-content`; sites or proxies using them remain unverified. Incomplete
bodies and CDN rewrites that prevent byte comparison also leave identity
unverified. This is not browser execution or proof of every asset, replica, image
digest, Pod health, or
backend migration. Continue the independent
[rollout and application checks](../guides/deploy/production-upgrade.md#verify-the-release).

Use a canonical URL without credentials, query, fragment, dot segments, or a
leading double slash in its path. The command retains TLS trust, sends no cookies
or tokens, follows no redirects or page links, and fetches only the fixed
same-origin CSS after checking HTML. Limits are 256 KiB HTML, 2 MiB CSS, five
seconds per blocking operation and 20 seconds total. No response contents, URLs,
or exception details are printed.

`wrong-revision` and `wrong-asset` indicate mismatched delivery. Marker, HTML,
stylesheet, framing, size, content or timeout failures leave identity unproved.
`redirect-refused` can indicate sign-in or routing; `authentication-required`
means HTTP 401/403. These and `unavailable` do not establish a wrong version.
Inspect routing, access policy and caches privately, then rerun after correction;
do not weaken TLS or supply service credentials.
