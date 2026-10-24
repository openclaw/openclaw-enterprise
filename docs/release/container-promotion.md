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

After approved promotion and traffic selection, verify the Console served to
users. On a POSIX host, use Node.js 24 and Git with `--no-lazy-fetch`. Select the
full lowercase source commit from the receipt for the routed controller image.
For a runtime-only upgrade, use the previous controller receipt and commit when
checking the unchanged controller. Use a trusted checkout containing the
verifier and release producers. The source repository may be a separate local
checkout and need not be at the verifier's commit. Set `UPGRADE_EVIDENCE` to an
existing private directory for the result.

```bash
umask 077
export CONTROLLER_SOURCE_SHA='<full-lowercase-source-commit>'
export UPGRADE_EVIDENCE='/secure/occ/upgrades/<private-directory>'
cd /secure/tools/openclaw-enterprise # trusted checkout containing the verifier
node scripts/verify-console-release.ts /secure/src/openclaw-enterprise \
  "$CONTROLLER_SOURCE_SHA" 'https://console.example.com/console/' \
  > "$UPGRADE_EVIDENCE/console-verification.json"
```

| Input or limit | Requirement                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source         | The local repository must contain the commit and its Console source objects. Missing objects or a source template unsupported by this verifier return `invalid-source`; the command does not fetch objects or execute source from the selected commit.                                                                                                         |
| URL            | Use the canonical HTTPS URL without credentials, query, fragment, dot segments, or a path beginning with `//`. TLS verification stays enabled. The command sends no cookies or tokens and follows no redirects or page links.                                                                                                                                  |
| Responses      | Anonymous requests retrieve the HTML and then `/console/console.css` on the same origin. Each response needs exactly one `Content-Length` and one `Content-Type` (`text/html` or `text/css`, with only an optional `charset=utf-8`, quoted or unquoted). Compression, chunked or close-delimited bodies, ambiguous headers, and incomplete bodies are refused. |
| Budgets        | HTML is limited to 256 KiB and CSS to 2 MiB. Git commands and idle HTTPS sockets time out after five seconds. A 20-second deadline covers the whole check.                                                                                                                                                                                                     |

Keep the JSON result with the private publication and upgrade evidence. The
command emits no response contents, URL, or exception details.

| Result                                                       | Meaning and next action                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `verified` (exit 0)                                          | The delivered Console shell and base CSS match the source commit. The record includes `revision` and `assetSha256`.                    |
| `wrong-shell`, `wrong-asset`                                 | The delivered shell or CSS differs. Inspect the routed controller and caches before repeating the check.                               |
| `invalid-source`, `invalid-input`                            | Check the local commit and objects, receipt, and URL.                                                                                  |
| `redirect-refused`, `authentication-required`, `unavailable` | Inspect routing and access policy. `authentication-required` means HTTP 401 or 403.                                                    |
| Other refusals                                               | Check the response framing, content types, size, markup, or timeout named by the result. Correct the cause before repeating the check. |

The command exits 1 for refusals. It checks one delivered shell and base CSS,
including the supported themed shell. Theme settings and assets are
installation-owned and their values are not authenticated by this check. Browser
execution, other assets and replicas, image digest, Pod health, and backend
migrations require separate evidence. Keep TLS verification enabled and do not
supply service credentials when correcting a refusal. Continue the
[rollout and application checks](../guides/deploy/production-upgrade.md#verify-the-release).
