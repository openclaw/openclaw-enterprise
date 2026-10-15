import { createServer, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Agent, get } from "node:https";
import { URL, URLSearchParams } from "node:url";

const origin = "https://api.github.com";
const maxConcurrent = 3;
const maxResponseBytes = 12 * 1024 * 1024;
const pageNumber = /^(?:[1-9]\d{0,2}|1000)$/;
const paging = { page: pageNumber, per_page: /^(?:[1-9]\d?|100)$/ };
const cursor = /^[A-Za-z0-9+/_-]{1,1024}={0,2}$/;
const listing = { ...paging, state: /^(?:all|open|closed)$/, direction: /^(?:asc|desc)$/ };
const component = /^(?!\.{1,2}$)[a-z\d._-]{1,100}$/i;
const ref = /^(?!.*(?:\.\.|\/\/|\/$))[a-z\d][a-z\d._/-]{0,179}$/i;

function readRoute(target: string) {
  // Validate the origin-form path before any URL parser can normalize dot segments.
  if (target.length > 2048 || /[^\x21-\x7e]|[\\#]/.test(target)) {
    return;
  }
  const [path = "", search, extra] = target.split("?");
  const [empty, repos, owner = "", repo = "", resource, ...tail] = path.split("/");
  if (
    empty !== "" ||
    repos !== "repos" ||
    !component.test(repo) ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) ||
    extra !== undefined ||
    (search !== undefined && !/^(?:[a-z_]+=[^=&]+&)*[a-z_]+=[^=&]+$/.test(search))
  ) {
    return;
  }
  let fields: Record<string, RegExp>;
  if (resource === "contents" && tail.every((part) => component.test(part))) {
    fields = { ref };
  } else if (resource === undefined) {
    fields = {};
  } else if (/^(?:pulls|issues|releases)$/.test(resource)) {
    if (tail.length === 1 && /^[1-9]\d{0,14}$/.test(tail[0]!)) {
      fields = {};
    } else if (tail.length !== 0) {
      return;
    } else if (resource === "pulls") {
      fields = { ...listing, base: ref, sort: /^(?:created|updated|popularity|long-running)$/ };
    } else if (resource === "issues") {
      fields = {
        ...listing,
        after: cursor,
        before: cursor,
        sort: /^(?:created|updated|comments)$/,
      };
    } else {
      fields = paging;
    }
  } else {
    return;
  }
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (!Object.hasOwn(fields, key) || !fields[key]!.test(value) || params.has(key)) {
      return;
    }
    params.set(key, value);
  }
  if (params.has("after") && params.has("before")) {
    return;
  }
  params.sort();
  return {
    path,
    params,
    resource,
    list: Object.hasOwn(fields, "page"),
    target: path + (params.size ? "?" + params.toString() : ""),
  };
}

type Route = NonNullable<ReturnType<typeof readRoute>>;
type Result = { status: number; body: string | Buffer; headers?: OutgoingHttpHeaders };
function message(status: number, text: string, headers: OutgoingHttpHeaders = {}): Result {
  return { status, body: JSON.stringify({ message: text }), headers };
}

function listPage(body: Buffer, value: string, route: Route): Result {
  // GitHub can use /repositories/{numeric ID}. Publish only a local page of the
  // original query, never an absolute URL or a different provider-supplied path.
  const matches = [...value.matchAll(/<([^>]+)>;\s*rel="(next|prev|first|last)"/g)];
  const nextCount = (value.match(/\brel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next\b)/gi) ?? []).length;
  if (nextCount !== matches.filter(([, , rel]) => rel === "next").length) {
    return message(502, "Listing is incomplete: GitHub's next link cannot be safely represented.");
  }
  const links = [];
  for (const [, href = "", rel] of matches) {
    const url = URL.parse(href);
    const resource = url?.pathname.match(/^\/repositories\/\d+\/(pulls|issues|releases)$/)?.[1];
    const namedPath =
      url?.pathname.startsWith("/repos/") &&
      url.pathname.endsWith("/" + route.resource) &&
      url.pathname.toLowerCase() === route.path.toLowerCase();
    const pages = url?.searchParams.getAll("page") ?? [];
    const after = url?.searchParams.getAll("after") ?? [];
    const before = url?.searchParams.getAll("before") ?? [];
    const validCursor =
      after.length + before.length <= 1 &&
      (after.length + before.length === 0 || route.resource === "issues") &&
      [...after, ...before].every((item) => cursor.test(item));
    if (
      url?.origin !== origin ||
      (!namedPath && resource !== route.resource) ||
      pages.length !== 1 ||
      !pageNumber.test(pages[0]!) ||
      (rel === "next" && route.params.get("page") === "1000") ||
      !validCursor
    ) {
      if (rel === "next") {
        return message(
          502,
          "Listing is incomplete: GitHub's next page cannot be safely represented within the supported range of 1 to 1000.",
        );
      }
      continue;
    }
    const params = new URLSearchParams(route.params);
    params.delete("after");
    params.delete("before");
    params.set("page", pages[0]!);
    if (after.length) {
      params.set("after", after[0]!);
    } else if (before.length) {
      params.set("before", before[0]!);
    }
    const target = route.path + "?" + params.toString();
    if (!readRoute(target)) {
      if (rel === "next") {
        return message(
          502,
          "Listing is incomplete: GitHub's next page cannot be safely represented.",
        );
      }
      continue;
    }
    links.push("<" + target + '>; rel="' + rel + '"');
  }
  return { status: 200, body, headers: links.length ? { link: links.join(", ") } : {} };
}

interface Content {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
  content?: string;
  encoding?: string;
}
function metadata({ name, path, sha, size, type }: Content) {
  return { name, path, sha, size, type };
}
function contents(bytes: Buffer): Result {
  const item: Content | Content[] = JSON.parse(bytes.toString());
  let body;
  if (Array.isArray(item)) {
    if (item.length >= 1000) {
      return message(
        502,
        "Directory listing is possibly incomplete: GitHub limits it to 1000 entries.",
      );
    }
    body = item.map(metadata);
  } else if (item.type !== "file") {
    body = metadata(item);
  } else {
    if (item.size > 1024 * 1024) {
      return message(413, "Only files up to 1 MiB are available inline.");
    }
    const content = item.content?.replace(/\s/g, "");
    const decoded = Buffer.from(content ?? "", "base64");
    if (
      item.encoding !== "base64" ||
      decoded.length !== item.size ||
      decoded.toString("base64") !== content
    ) {
      return message(502, "GitHub did not supply the complete file as inline base64.");
    }
    body = { ...metadata(item), encoding: "base64", content };
  }
  return { status: 200, body: JSON.stringify(body) };
}

export function createPublicGithubReadServer() {
  const agent = new Agent({ keepAlive: true, maxSockets: maxConcurrent });
  const pending = new Map<string, Promise<Result>>();
  let retryAt = 0;

  function limited(): Result {
    return message(
      429,
      "GitHub anonymous reads are rate limited. Retry after the indicated seconds.",
      { "retry-after": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))) },
    );
  }

  async function read(route: Route): Promise<Result> {
    const signal = AbortSignal.timeout(24_000);
    try {
      // A new GET to a fixed, verified TLS origin. No redirects, proxy environment,
      // client headers or credential sources participate in this provider request.
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        get(
          origin + route.target,
          {
            agent,
            signal,
            headers: {
              accept: "application/vnd.github+json",
              "accept-encoding": "identity",
              "user-agent": "openclaw-enterprise-public-github-read",
              "x-github-api-version": "2022-11-28",
            },
          },
          resolve,
        ).once("error", reject);
      });
      const { statusCode: status = 502, headers } = response;
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response) {
        length += chunk.length;
        if (length > maxResponseBytes) {
          return message(502, "GitHub response exceeded 12 MiB. Request a smaller page.");
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, length);
      const exhausted = headers["x-ratelimit-remaining"] === "0";
      const throttled =
        status === 429 ||
        (status === 403 &&
          (exhausted ||
            headers["retry-after"] ||
            /rate limit|abuse detection/i.test(bytes.subarray(0, 4096).toString())));
      if (throttled || (status === 200 && exhausted)) {
        const now = Date.now();
        const seconds =
          Number(headers["retry-after"]) ||
          (exhausted && Number(headers["x-ratelimit-reset"]) - now / 1000) ||
          60;
        retryAt = Math.max(retryAt, now + Math.min(86400, Math.max(1, seconds)) * 1000);
      }
      if (throttled) {
        return limited();
      }
      if (status !== 200) {
        return status === 404
          ? message(404, "Not found")
          : message(
              status >= 400 && status < 500 ? status : 502,
              "GitHub did not return the requested data. Redirects are not followed.",
            );
      }
      if (
        !/^application\/(?:json|vnd\.github(?:\.[\w-]+)?\+json)\b/i.test(
          headers["content-type"] ?? "",
        )
      ) {
        return message(502, "GitHub returned a non-JSON representation.");
      }
      if (route.resource === "contents") {
        return contents(bytes);
      }
      return route.list && headers.link
        ? listPage(bytes, String(headers.link), route)
        : { status, body: bytes };
    } catch {
      return signal.aborted
        ? message(504, "GitHub did not complete the read within 24 seconds.")
        : message(
            502,
            "The anonymous GitHub read did not complete. No saved or partial data was returned.",
          );
    }
  }

  const server = createServer(
    { headersTimeout: 6000, requestTimeout: 8000, maxHeaderSize: 8192 },
    async (req, res) => {
      let result: Result;
      const target = req.url ?? "";
      const route = readRoute(target);
      if (req.method !== "GET") {
        result = message(405, "Only GET is allowed.", { allow: "GET" });
      } else if (
        req.headers["transfer-encoding"] !== undefined ||
        Number(req.headers["content-length"] ?? 0) !== 0
      ) {
        result = message(400, "GET must have no request body.");
      } else if (target === "/healthz") {
        result = message(200, "ready");
      } else if (!route) {
        result = message(
          400,
          "Expected a supported /repos/{owner}/{repository} public read and query.",
        );
      } else if (Date.now() < retryAt) {
        result = limited();
      } else {
        const sameRead = pending.get(route.target);
        if (sameRead) {
          result = await sameRead;
        } else if (pending.size >= maxConcurrent) {
          result = message(503, "Public GitHub reader is busy. Retry shortly.", {
            "retry-after": "2",
          });
        } else {
          const reading = read(route).finally(() => {
            pending.delete(route.target);
          });
          pending.set(route.target, reading);
          result = await reading;
        }
      }
      res.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...result.headers,
      });
      res.end(result.body);
    },
  );
  server.maxConnections = 48;
  server.maxRequestsPerSocket = 16;
  server.keepAliveTimeout = 4000;
  server.setTimeout(30_000);
  server.once("close", () => agent.destroy());
  return server;
}

if (import.meta.main) {
  createPublicGithubReadServer().listen(8080);
}
