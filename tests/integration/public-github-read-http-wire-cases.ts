import assert from "node:assert/strict";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  RequestListener,
  RequestOptions,
} from "node:http";
import type { TestContext } from "node:test";

const json = { "content-type": "application/json" };

type ReaderHttpWireFixtures = {
  origin: string;
  repo: string;
  fetch: typeof globalThis.fetch;
  get: (path?: string, options?: RequestInit) => Promise<Response>;
  rawRequest: (url: string, options: RequestOptions, body: string) => Promise<IncomingMessage>;
  answer: (status: number, body: unknown, headers?: OutgoingHttpHeaders) => void;
  setReply: (handler: RequestListener) => void;
  requestCount: () => number;
};

export function publicGithubReadNextPage(response: Response, origin: string): URL {
  const link = response.headers.get("link");
  assert.ok(link, "expected a continuation Link header");
  const end = link.indexOf(">");
  assert.ok(link.startsWith("<") && end > 1, "expected a continuation target");
  return new URL(link.slice(1, end), origin);
}

async function responseMessage(response: Response): Promise<string> {
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "message" in body);
  assert.ok(typeof body.message === "string", "expected a reader error message");
  return body.message;
}

export async function runPublicGithubReadHttpWireCases(
  t: TestContext,
  { origin, repo, fetch, get, rawRequest, answer, setReply, requestCount }: ReaderHttpWireFixtures,
): Promise<void> {
  const issues = "https://api.github.com/repositories/12/issues?";
  // A provider listing whose next page is this link.
  const nextPage = (link: string | URL) => answer(200, [], { link: `<${link}>; rel="next"` });

  await t.test("issue cursors survive local pagination when earlier issues disappear", async () => {
    const issued = "opaque+/cursor==";
    setReply((req, res) => {
      assert.ok(req.url);
      const url = new URL(req.url, "https://api.github.com");
      const after = url.searchParams.get("after");
      if (!url.searchParams.has("page")) {
        const next = new URL(issues + "per_page=2&page=2&state=open");
        next.searchParams.set("after", issued);
        res.writeHead(200, { ...json, link: `<${next}>; rel="next"` });
        res.end(JSON.stringify([{ number: 1 }, { number: 2 }]));
      } else {
        assert.equal(url.searchParams.get("state"), "all");
        res.writeHead(200, json);
        // After issue 1 disappears, offset page 2 is empty; the issued cursor still finds issue 3.
        res.end(JSON.stringify(after === issued ? [{ number: 3 }] : []));
      }
    });
    const numbers = async (response: Response) => {
      const body: unknown = await response.json();
      assert.ok(Array.isArray(body), "expected an issue list");
      return body.map((issue: unknown) => {
        assert.ok(typeof issue === "object" && issue !== null && "number" in issue);
        assert.ok(typeof issue.number === "number", "expected an issue number");
        return issue.number;
      });
    };
    const first = await get("/issues?state=all&per_page=2");
    assert.deepEqual(await numbers(first), [1, 2]);
    const next = publicGithubReadNextPage(first, origin);
    assert.equal(next.pathname, repo + "/issues");
    assert.deepEqual(Object.fromEntries(next.searchParams), {
      per_page: "2",
      state: "all",
      page: "2",
      after: issued,
    });
    const second = await fetch(next);
    assert.equal(second.status, 200);
    assert.deepEqual(await numbers(second), [3]);

    const newer = new URL(issues + "page=3");
    newer.searchParams.set("before", "next_cursor");
    nextPage(newer);
    const replaced = publicGithubReadNextPage(await fetch(next), origin);
    assert.equal(replaced.searchParams.get("after"), null);
    assert.equal(replaced.searchParams.get("before"), "next_cursor");

    nextPage("https://api.github.com/repos/example/project/issues?page=2&after=cursor");
    const named = await fetch(origin + "/repos/Example/Project/issues?state=all");
    assert.equal(named.status, 200);
    const namedNext = publicGithubReadNextPage(named, origin);
    assert.equal(namedNext.pathname, "/repos/Example/Project/issues");
    assert.equal(namedNext.searchParams.get("after"), "cursor");
  });
  await t.test("unsafe issue continuations fail instead of reporting a complete list", async () => {
    for (const [path, link] of [
      ...[
        "page=2&after=invalid%20cursor",
        "page=2&after=one&after=two",
        "page=2&after=one&before=two",
        "page=2&page=3&after=one",
        "page=2&after=" + "a".repeat(1025),
        "page=1001&after=one",
        "after=one",
        "page=2&after=" + "%2F".repeat(700),
      ].map((query) => ["/issues?state=all", `<${issues}${query}>; rel="next"`] as const),
      ["/issues", `<${issues}page=2>; rel=next`],
      ["/issues", '<https://unrelated.invalid/repositories/12/issues?page=2>; rel="next"'],
      ["/pulls", '<https://api.github.com/repositories/12/pulls?page=2&after=cursor>; rel="next"'],
    ]) {
      answer(200, [], { link });
      const response = await get(path);
      assert.equal(response.status, 502, link);
      assert.match(await responseMessage(response), /incomplete/i);
    }
    const before = requestCount();
    for (const path of [
      "/issues?after=bad%20cursor",
      "/issues?after=one&after=two",
      "/issues?after=one&before=two",
      "/issues?after=" + "a".repeat(1025),
      "/issues/1?after=one",
      "/pulls?after=one",
      "/releases?before=one",
    ]) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.equal(requestCount(), before);
  });
  await t.test("page 1000 succeeds only if the provider has no next page", async () => {
    answer(200, []);
    const last = await get("/pulls?page=1000");
    assert.equal(last.status, 200);
    assert.equal(last.headers.get("link"), null);

    for (const [path, next] of [
      ["/pulls?page=1000", "pulls?page=1001"],
      ["/issues?page=1000", "issues?page=1000&after=cursor"],
    ] as const) {
      nextPage("https://api.github.com/repositories/12/" + next);
      const incomplete = await get(path);
      assert.equal(incomplete.status, 502, path);
      assert.match(await responseMessage(incomplete), /incomplete.*1000/i);
    }
  });
  await t.test("a directory at GitHub's entry limit cannot establish completeness", async () => {
    const entries = (length: number) =>
      Array.from({ length }, () => ({ name: "entry", type: "file", size: 0 }));
    answer(200, entries(999));
    const belowLimit = await get("/contents");
    assert.equal(belowLimit.status, 200);
    const body: unknown = await belowLimit.json();
    assert.ok(Array.isArray(body), "expected a directory listing");
    assert.equal(body.length, 999);

    answer(200, entries(1000));
    const atLimit = await get("/contents");
    assert.equal(atLimit.status, 502);
    assert.match(await responseMessage(atLimit), /possibly incomplete.*1000/i);
  });
  await t.test(
    "writes, bodies and alternate routes fail locally; provider redirects are never followed",
    async () => {
      const before = requestCount();
      const write = await get("/pulls", { method: "POST", body: "{}" });
      assert.equal(write.status, 405);
      assert.equal(write.headers.get("allow"), "GET");
      const withBody = await rawRequest(
        origin + repo,
        { headers: { "content-length": "2" } },
        "{}",
      );
      assert.equal(withBody.statusCode, 400);
      withBody.resume();
      for (const path of [
        "?access_token=synthetic",
        "/pulls?per_page=101",
        "/contents/%2e%2e%2fprivate",
        "/contents/file?raw=true",
        "/pulls?sort=updated&sort=created",
        "/releases/download/file",
      ]) {
        assert.equal((await get(path)).status, 400, path);
      }
      assert.equal((await fetch(origin + "/graphql")).status, 400);
      assert.equal(requestCount(), before);
      answer(302, {}, { location: "https://unrelated.invalid/redirect" });
      const redirect = await get();
      assert.equal(redirect.status, 502);
      assert.equal(redirect.headers.get("location"), null);
      assert.equal(requestCount(), before + 1);
    },
  );
  await t.test(
    "only complete bounded inline files or directory metadata, never download URLs or partial data",
    async () => {
      const file = {
        name: "readme",
        type: "file",
        size: 5,
        encoding: "base64",
        content: "aGVsbG8=",
        download_url: "https://unrelated.invalid/download",
      };
      answer(200, [file]);
      assert.deepEqual(await (await get("/contents")).json(), [
        { name: "readme", size: 5, type: "file" },
      ]);
      answer(200, file);
      const complete: unknown = await (await get("/contents/readme?ref=feature%2Fexample")).json();
      assert.ok(typeof complete === "object" && complete !== null && "content" in complete);
      assert.ok(typeof complete.content === "string", "expected inline base64 content");
      assert.equal(Buffer.from(complete.content, "base64").toString(), "hello");
      assert.ok(!("download_url" in complete));
      const invalidFiles: readonly [string, number, string | Buffer, OutgoingHttpHeaders?][] = [
        ["/contents/readme", 413, JSON.stringify({ ...file, size: 1048577 })],
        ["/contents/readme", 502, JSON.stringify({ ...file, size: 6 })],
        // The provider closes before the 100 bytes it announced.
        ["/issues/3", 502, "[7]", { ...json, "content-length": "100", connection: "close" }],
        // One byte over the 12 MiB response bound.
        ["/releases/4", 502, Buffer.alloc(12 * 1024 * 1024 + 1)],
      ];
      for (const [path, status, body, headers = json] of invalidFiles) {
        setReply((_req, res) => res.writeHead(200, headers).end(body));
        assert.equal((await get(path)).status, status, path);
      }
    },
  );
}
