import assert from "node:assert/strict";
import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createGitHubTeamRoster,
  verifyGitHubTeamSignIn,
} from "../../apps/controller/src/auth/github-team-roster.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const target = { organizationId: "11", teamId: "21" };
const team = { id: 21, node_id: "T_fixture", organization: { id: 11 }, privacy: "closed" };
const user = { id: 31, type: "User", login: "octo" };
const serviceToken = `ghs_${"fixture"}`;
const signal = () => AbortSignal.timeout(5_000);

function graph(ids: number[], totalCount = ids.length, hasNextPage = false) {
  return {
    data: {
      team: {
        id: "T_fixture",
        databaseId: 21,
        organization: {
          databaseId: 11,
          subjectTeams: {
            nodes: [] as { databaseId: number }[],
            totalCount: 0,
            pageInfo: { hasNextPage: false },
          },
        },
        members: {
          nodes: ids.map((databaseId) => ({ databaseId })),
          totalCount,
          pageInfo: { hasNextPage, endCursor: ids.length ? "fixture-cursor" : null },
        },
      },
      subject: { databaseId: 31, login: "octo" },
      viewer: { databaseId: 31 },
    },
  };
}

// Exercise the production adapter against recorded wire shapes. Never allow a
// request outside the fixture, including when a malformed page asks for another.
function provider(t: TestContext, replies: Response[]) {
  const requests: { path: string; authorization: string | null; body: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init.redirect, "error");
    requests.push({
      path: url.pathname,
      authorization: new Headers(init.headers).get("authorization"),
      body: typeof init.body === "string" ? init.body : "",
    });
    assert.ok(replies.length, "all provider calls must have a fixture");
    return replies.shift();
  });
  t.after(() => assert.equal(replies.length, 0, "the entire fixture must have been observed"));
  return requests;
}

async function worker(t: TestContext) {
  const dir = await temporaryDirectory(t, "github-team-");
  const path = join(dir, "token");
  await writeFile(path, serviceToken, { mode: 0o600 });
  return createGitHubTeamRoster(path);
}

test("complete pages grant immutable subjects; a missing subject needs an independent, ID-bound check", async (t) => {
  const adapter = await worker(t);
  const members = Array.from({ length: 101 }, (_, i) => i + 1000);
  const requests = provider(t, [
    Response.json(team),
    Response.json(graph(members.slice(0, 100), 101, true)),
    Response.json(graph(members.slice(100), 101)),
    Response.json(user),
    Response.json(graph([])),
  ]);
  assert.deepEqual(await adapter.readServiceRoster(target, ["1001", "31"], signal()), {
    status: "complete",
    presentSubjects: members.map(String),
    confirmedAbsentSubjects: ["31"],
  });
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/organizations/11/team/21", "/graphql", "/graphql", "/user/31", "/graphql"],
  );
  assert.ok(requests.every((r) => r.authorization === `Bearer ${serviceToken}`));
  assert.deepEqual(JSON.parse(requests[2]!.body).variables, {
    team: team.node_id,
    after: "fixture-cursor",
  });
  const confirmation = JSON.parse(requests[4]!.body);
  assert.deepEqual(confirmation.variables, {
    team: team.node_id,
    login: user.login,
    signIn: false,
  });
  assert.match(confirmation.query, /members\([^)]*query: \$login/);
});

test("sign-in and refresh require an organization-visible team before reading memberships", async (t) => {
  const adapter = await worker(t);
  for (const privacy of ["secret", undefined, "unknown"]) {
    await t.test(privacy ?? "missing", async (sub) => {
      const metadata = { ...team, privacy };
      const requests = provider(sub, [Response.json(metadata), Response.json(metadata)]);
      assert.equal(
        await verifyGitHubTeamSignIn(target, "31", "fixture-user-token", signal()),
        "unavailable",
      );
      assert.deepEqual(await adapter.readServiceRoster(target, ["31"], signal()), {
        status: "unavailable",
      });
      assert.deepEqual(
        requests.map((request) => request.path),
        ["/organizations/11/team/21", "/organizations/11/team/21"],
      );
    });
  }
});

test("retain on hidden, ambiguous or changing membership", async (t) => {
  const adapter = await worker(t);
  const renamed = graph([]);
  renamed.data.subject.databaseId = 32;
  const incorrectTeam = graph([]);
  incorrectTeam.data.team.organization.databaseId = 12;
  const retainedTeam = graph([]);
  retainedTeam.data.team.organization.subjectTeams.nodes.push({ databaseId: 21 });
  retainedTeam.data.team.organization.subjectTeams.totalCount = 1;
  const firstPage = Array.from({ length: 100 }, (_, i) => i + 1000);
  const cases: [string, Response[]][] = [
    [
      "empty search contradicts exact user's team list",
      [
        Response.json(team),
        Response.json(graph([])),
        Response.json(user),
        Response.json(retainedTeam),
      ],
    ],
    ["hidden team", [new Response(null, { status: 404 })]],
    ["wrong organization", [Response.json(team), Response.json(incorrectTeam)]],
    [
      "known partial visibility",
      [
        Response.json(team),
        Response.json(graph([]), { headers: { "x-github-sso": "partial-results" } }),
      ],
    ],
    [
      "partial GraphQL data",
      [Response.json(team), Response.json({ ...graph([]), errors: [{ message: "fixture" }] })],
    ],
    [
      "duplicate across cursor pages",
      [
        Response.json(team),
        Response.json(graph(firstPage, 101, true)),
        Response.json(graph([1000], 101)),
      ],
    ],
    [
      "count changed",
      [
        Response.json(team),
        Response.json(graph(firstPage, 101, true)),
        Response.json(graph([1100], 102)),
      ],
    ],
    [
      "hidden subject",
      [Response.json(team), Response.json(graph([])), new Response(null, { status: 404 })],
    ],
    [
      "reassigned login",
      [Response.json(team), Response.json(graph([])), Response.json(user), Response.json(renamed)],
    ],
    [
      "fuzzy near match",
      [
        Response.json(team),
        Response.json(graph([])),
        Response.json(user),
        Response.json(graph([32])),
      ],
    ],
  ];
  for (const [name, replies] of cases) {
    await t.test(name, async (sub) => {
      provider(sub, replies);
      assert.deepEqual(await adapter.readServiceRoster(target, ["31"], signal()), {
        status: "unavailable",
      });
    });
  }
});

test("resolve each omitted grant independently and publish withdrawals only after every omission resolves", async (t) => {
  const adapter = await worker(t);
  const other = { id: 32, type: "User", login: "other" };
  const absent = graph([]);
  absent.data.subject = { databaseId: 32, login: "other" };
  provider(t, [
    Response.json(team),
    Response.json(graph([99])),
    Response.json(user),
    Response.json(graph([31])),
    Response.json(other),
    Response.json(absent),
    Response.json(team),
    Response.json(graph([99])),
    Response.json(other),
    Response.json(absent),
    new Response(null, { status: 404 }),
  ]);
  // The cursor walk omitted both known members. An individual positive resolves
  // the first omission and does not invalidate the second user's confirmed departure.
  assert.deepEqual(await adapter.readServiceRoster(target, ["31", "32"], signal()), {
    status: "complete",
    presentSubjects: ["99", "31"],
    confirmedAbsentSubjects: ["32"],
  });
  // This time even the completed absence cannot be applied: the subsequent
  // account lookup failed, so the whole run yields no publishable observation.
  assert.deepEqual(await adapter.readServiceRoster(target, ["32", "31"], signal()), {
    status: "unavailable",
  });
});

test("the callback can prove membership only for its authenticated GitHub user in the selected team", async (t) => {
  const wrongViewer = graph([31]);
  wrongViewer.data.viewer.databaseId = 32;
  const replies = [
    Response.json(team),
    Response.json(user),
    Response.json(graph([31])),
    Response.json(team),
    Response.json(user),
    Response.json(wrongViewer),
  ];
  const requests = provider(t, replies);
  assert.equal(
    await verifyGitHubTeamSignIn(target, "31", "fixture-user-token", signal()),
    "present",
  );
  assert.equal(
    await verifyGitHubTeamSignIn(target, "31", "fixture-user-token", signal()),
    "unavailable",
  );
  assert.ok(requests.every((r) => r.authorization === "Bearer fixture-user-token"));
});

test("the worker follows Secret generation rotation and refuses unsafe credential files before contacting GitHub", async (t) => {
  const dir = await temporaryDirectory(t, "github-team-rotation-");
  for (const generation of ["..one", "..two"]) {
    await mkdir(join(dir, generation), { mode: 0o750 });
    await writeFile(join(dir, generation, "token"), `${serviceToken}${generation}\n`, {
      mode: 0o440,
    });
  }
  await symlink("..one", join(dir, "..data"));
  await symlink("..data/token", join(dir, "token"));
  const adapter = createGitHubTeamRoster(join(dir, "token"));
  const requests = provider(t, [
    Response.json(team),
    Response.json(graph([])),
    Response.json(team),
    Response.json(graph([])),
  ]);
  const expected = { status: "complete", presentSubjects: [], confirmedAbsentSubjects: [] };
  assert.deepEqual(await adapter.readServiceRoster(target, [], signal()), expected);
  await symlink("..two", join(dir, "..next"));
  await rename(join(dir, "..next"), join(dir, "..data"));
  assert.deepEqual(await adapter.readServiceRoster(target, [], signal()), expected);
  await chmod(join(dir, "..two", "token"), 0o444);
  assert.deepEqual(await adapter.readServiceRoster(target, [], signal()), {
    status: "unavailable",
  });
  await chmod(join(dir, "..two", "token"), 0o600);
  await writeFile(join(dir, "..two", "token"), "fixture-personal-token");
  assert.deepEqual(await adapter.readServiceRoster(target, [], signal()), {
    status: "unavailable",
  });
  assert.deepEqual(
    requests.map((r) => r.authorization),
    [
      `Bearer ${serviceToken}..one`,
      `Bearer ${serviceToken}..one`,
      `Bearer ${serviceToken}..two`,
      `Bearer ${serviceToken}..two`,
    ],
  );
});

test("GitHub membership requires unambiguous object names and exact JSON integers on the wire", async (t) => {
  const adapter = await worker(t);
  const page = JSON.stringify(graph([31]));
  const member = '"nodes":[{"databaseId":31}]';
  const cases = [
    [
      "duplicate member identity",
      page.replace(member, String.raw`"nodes":[{"databaseId":32,"datab\u0061seId":31}]`),
    ],
    [
      "rounded member identity",
      page.replace(member, '"nodes":[{"databaseId":31.0000000000000001}]'),
    ],
    ["unsafe member identity", page.replace(member, '"nodes":[{"databaseId":9007199254740993}]')],
    ["rounded roster count", page.replace('"totalCount":1', '"totalCount":1.0000000000000001')],
    ["unsafe roster count", page.replace('"totalCount":1', '"totalCount":9007199254740993')],
  ] as const;
  for (const [name, body] of cases) {
    await t.test(name, async (sub) => {
      // Preserve the provider's original tokens. Constructing a Response.json fixture
      // would normalize the exact ambiguity both callers need to reject.
      assert.notEqual(body, page);
      provider(sub, [
        Response.json(team),
        Response.json(user),
        new Response(body),
        Response.json(team),
        new Response(body),
      ]);
      const signIn = await verifyGitHubTeamSignIn(target, "31", "fixture-user-token", signal());
      const service = await adapter.readServiceRoster(target, [], signal());
      assert.deepEqual(
        { signIn, service },
        { signIn: "unavailable", service: { status: "unavailable" } },
      );
    });
  }
});
