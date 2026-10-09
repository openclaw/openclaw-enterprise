---
status: Proposed
implementation_status: Not implemented
author: freeqaz
status_note: "Needs human review before landing. No implementation accompanies this proposal."
---

# Proposal: Cacheable Console assets

- **ID:** RFC-0019
- **Owner:** Controller HTTP serving and Console. Review: Console and release owners.
- **Created:** 2026-10-02
- **Last updated:** 2026-10-02
- **RFC PR:** this PR (draft)
- **Related:** dogfood finding D55 (Console load time on local k3d).

<a id="problem-and-decision"></a>

## Summary

The Console is about 40 unbundled ES modules, two style sheets, a font and icons, all
served with `cache-control: no-store`. Every page load fetches every file again. This RFC
proposes a versioned asset path with long-lived caching, keeps the HTML shell uncached,
and asks for a re-measurement on a quiet host before anyone builds it.

## Motivation

During dogfood the Console took 5 to 13 seconds to load: 43 requests over HTTP/1.1, with
1.5 to 3.3 second connection stalls. `curl` fetched each file in 25 to 120 ms. That
measurement ran under heavy host load (load average about 250) through a VM port forward,
so it overstates the cost. The pattern still holds on any link: a browser opens about six
HTTP/1.1 connections per origin, and the module graph is several levels deep, so load time
grows with round-trip time × import depth.

Today `responseHeaders` (`apps/controller/src/http/errors.ts`) sets `no-store` in a global
`onRequest` hook, and `serveConsole` (`apps/controller/src/index.ts`) does not override it.
No asset carries an `ETag` or `Last-Modified`, so the browser cannot even revalidate.

`no-store` does prevent one failure: after an upgrade, a browser cannot combine cached
modules from the old build with modules from the new one. Any change must keep that
guarantee.

## Goals

- A repeat visit fetches only the HTML shell; each asset is fetched once per build.
- A browser never combines assets from two builds.
- No new build step that developers must run before `pnpm dev` works.
- API responses keep `no-store`.

## Options

### A. Versioned asset path, immutable caching (recommended)

Serve assets at `/console/_/<build-revision>/<path>` with
`cache-control: public, max-age=31536000, immutable`. Keep the HTML shell and
the current unversioned paths at `no-store`. `scripts/build-console-metadata.mjs` already
writes the build revision into `index.html` (`occ-build-revision`). It would also rewrite
the shell's `<script>` and `<link>` URLs to the versioned prefix. Relative imports between
modules resolve under that prefix, so module sources do not change. No module imports
by absolute path today. Three image references (`/console/oce-mascot.png`) can stay
unversioned, or move to `new URL(..., import.meta.url)`. A request whose revision
differs from the running build answers `404`; the shell is uncached, so the next load
picks up the new revision. Development builds without a revision keep today's paths and
`no-store`.

Cost: a route, a header rule, a small rewrite step, and a test that every shell
reference resolves.

### B. `ETag` plus `no-cache`

Add a content hash `ETag` and answer `304` to `If-None-Match`. This saves bytes, not
round trips: every module is still requested on every load. It is cheap, but it does not
address the measured stall.

### C. Bundle the Console

Build one or a few bundles with a bundler at image build time. This gives the fewest
requests, but it adds a build tool and source maps to debugging, and it diverges from
the "serve source as-is" model that `pnpm dev`, Storybook and the browser tests use.

### D. HTTP/2 at the ingress

Terminating TLS with HTTP/2 at the ingress removes the six-connection limit. It is an
operator choice, not a product change, and it does not help port-forwarded or plain-HTTP
development installs. The installation docs can recommend it with any option.

## Decision requested

1. Re-measure first: cold and warm Console loads on a quiet host and on a production-like
   ingress. If warm loads are under about one second, close D55 without a change.
2. If a change is still wanted, approve Option A, or choose B or C.

## Risks

- A cached asset from a revoked build stays in browsers until it expires. The assets are
  public code with no secrets, so this is acceptable. The shell decides which build
  runs.
- A proxy that caches by path without the revision segment would break Option A. The
  revision is in the path, not a query string, to avoid that.
