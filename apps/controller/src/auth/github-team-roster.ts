import { isGitHubTeamDatabaseId } from "./configuration.ts";
import { readGitHubRosterTokenFile } from "./github-team-roster-token.ts";
import { parseJsonMembers } from "../drivers/repo/credentials/json-members.ts";
import { readBoundedJSON } from "./provider-transport.ts";

interface TeamTarget {
  readonly organizationId: string;
  readonly teamId: string;
}

type SubjectMembership = "present" | "absent" | "unavailable";
type RosterObservation =
  | { status: "complete"; presentSubjects: string[]; confirmedAbsentSubjects: string[] }
  | { status: "unavailable" };

const maxPages = 100;
const pageSize = 100;

function requireObservation(condition: unknown): asserts condition {
  if (!condition) {
    throw new Error("GitHub team membership unavailable.");
  }
}

function record(value: unknown): Record<string, unknown> {
  requireObservation(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function databaseId(value: unknown): string {
  requireObservation(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return String(value);
}

// Check the wire token as well as the JS value: JSON.parse can round a fractional
// account ID or count to the expected integer, or select the last duplicate key.
function decodeRoster(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return parseJsonMembers(
    text,
    () => {
      throw new Error("Ambiguous GitHub membership response.");
    },
    (key, value, context) => {
      if (
        (key === "id" || key === "databaseId" || key === "totalCount") &&
        typeof value === "number"
      ) {
        requireObservation(
          Number.isSafeInteger(value) && value >= 0 && context?.source === String(value),
        );
      }
      return value;
    },
  );
}

async function observeTeam(target: TeamTarget, token: string, signal: AbortSignal) {
  requireObservation(
    isGitHubTeamDatabaseId(target.organizationId) && isGitHubTeamDatabaseId(target.teamId),
  );
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function request(path: string, query?: string, variables?: Record<string, unknown>) {
    signal.throwIfAborted();
    const response = await fetch(`https://api.github.com${path}`, {
      method: query ? "POST" : "GET",
      ...(query ? { body: JSON.stringify({ query, variables }) } : {}),
      headers,
      signal,
      redirect: "error",
    });
    if (response.status !== 200 || !response.body || response.headers.has("x-github-sso")) {
      await response.body?.cancel();
      throw new Error("GitHub team membership unavailable.");
    }
    return readBoundedJSON(response, response.body, signal, "membership", decodeRoster);
  }
  const team = await request(`/organizations/${target.organizationId}/team/${target.teamId}`);
  requireObservation(
    team.privacy === "closed" &&
      databaseId(team.id) === target.teamId &&
      databaseId(record(team.organization).id) === target.organizationId &&
      typeof team.node_id === "string" &&
      team.node_id.length > 0 &&
      team.node_id.length <= 256,
  );
  const teamId = team.node_id;

  async function page(query: string, variables: Record<string, unknown>) {
    const response = await request("/graphql", query, { ...variables, team: teamId });
    requireObservation(!("errors" in response));
    const data = record(response.data);
    const scoped = record(data.team);
    requireObservation(
      scoped.id === teamId &&
        databaseId(scoped.databaseId) === target.teamId &&
        databaseId(record(scoped.organization).databaseId) === target.organizationId,
    );
    const members = record(scoped.members);
    const count = members.totalCount;
    const info = record(members.pageInfo);
    requireObservation(
      typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0 &&
        count <= maxPages * pageSize &&
        Array.isArray(members.nodes) &&
        members.nodes.length <= pageSize &&
        members.nodes.length <= count &&
        typeof info.hasNextPage === "boolean" &&
        (members.nodes.length === 0
          ? info.endCursor === null
          : typeof info.endCursor === "string" &&
            info.endCursor.length > 0 &&
            info.endCursor.length <= 2048),
    );
    const subjects = members.nodes.map((node: unknown) => databaseId(record(node).databaseId));
    return { data, subjects, count, next: info.hasNextPage, cursor: info.endCursor };
  }

  async function subject(id: string, signIn: boolean): Promise<"present" | "absent"> {
    requireObservation(isGitHubTeamDatabaseId(id));
    // A login can change hands. Resolve the numeric ID and bind the login back to
    // that same account in the very response containing the filtered membership.
    const user = await request(`/user/${id}`);
    requireObservation(
      databaseId(user.id) === id &&
        user.type === "User" &&
        typeof user.login === "string" &&
        /^[A-Za-z0-9_-]{1,100}$/.test(user.login),
    );
    const result = await page(subjectQuery, { login: user.login, signIn });
    const bound = record(result.data.subject);
    requireObservation(
      databaseId(bound.databaseId) === id &&
        bound.login === user.login &&
        (!signIn || databaseId(record(result.data.viewer).databaseId) === id) &&
        !result.next &&
        result.count === result.subjects.length &&
        new Set(result.subjects).size === result.count,
    );
    // Search can also return near matches. Only the exact ID establishes membership,
    // and a nonempty ambiguous result cannot independently establish departure.
    if (result.subjects.includes(id)) {
      return "present";
    }
    requireObservation(result.count === 0);
    // Team.members(query:) is free-text search. Cross-check its empty result
    // against the organization's exact userLogins filter before marking a departure.
    const org = record(record(result.data.team).organization);
    const teams = record(org.subjectTeams);
    requireObservation(
      Array.isArray(teams.nodes) &&
        teams.nodes.length <= pageSize &&
        teams.totalCount === teams.nodes.length &&
        record(teams.pageInfo).hasNextPage === false,
    );
    const ids = teams.nodes.map((node: unknown) => databaseId(record(node).databaseId));
    requireObservation(new Set(ids).size === ids.length && !ids.includes(target.teamId));
    return "absent";
  }

  async function roster(): Promise<Set<string>> {
    const subjects = new Set<string>();
    const cursors = new Set<string>();
    let after: string | null = null;
    let expected: number | undefined;
    for (let i = 0; i < maxPages; i++) {
      const result = await page(rosterQuery, { after });
      expected ??= result.count;
      requireObservation(result.count === expected);
      for (const id of result.subjects) {
        requireObservation(!subjects.has(id));
        subjects.add(id);
      }
      if (!result.next) {
        requireObservation(subjects.size === expected);
        return subjects;
      }
      requireObservation(
        subjects.size < expected &&
          result.subjects.length === pageSize &&
          typeof result.cursor === "string" &&
          !cursors.has(result.cursor),
      );
      after = result.cursor;
      cursors.add(after);
    }
    throw new Error("GitHub team membership unavailable.");
  }
  return { roster, subject };
}

const fields = `nodes { databaseId } totalCount pageInfo { hasNextPage endCursor }`;
const identity = `id databaseId organization { databaseId }`;
const rosterQuery = `query TeamRoster($team: ID!, $after: String) {
  team: node(id: $team) { ... on Team { ${identity}
    members(first: 100, after: $after, membership: ALL, orderBy: {field: LOGIN, direction: ASC}) { ${fields} }
  } }
}`;
const subjectQuery = `query TeamSubject($team: ID!, $login: String!, $signIn: Boolean!) {
  viewer @include(if: $signIn) { databaseId }
  subject: user(login: $login) { databaseId login }
  team: node(id: $team) { ... on Team {
    id databaseId organization {
      databaseId
      subjectTeams: teams(first: 100, userLogins: [$login]) {
        nodes { databaseId } totalCount pageInfo { hasNextPage }
      }
    }
    members(first: 100, query: $login, membership: ALL) { ${fields} }
  } }
}`;

export async function verifyGitHubTeamSignIn(
  target: TeamTarget,
  authenticatedSubject: string,
  userAccessToken: string,
  signal: AbortSignal,
): Promise<SubjectMembership> {
  try {
    const observation = await observeTeam(target, userAccessToken, signal);
    return await observation.subject(authenticatedSubject, true);
  } catch {
    return "unavailable";
  }
}

export function createGitHubTeamRoster(tokenFile: string) {
  return {
    async readServiceRoster(
      target: TeamTarget,
      previouslyGrantedSubjects: readonly string[],
      signal: AbortSignal,
    ): Promise<RosterObservation> {
      try {
        const bytes = await readGitHubRosterTokenFile(tokenFile, 16 * 1024);
        let token: string;
        try {
          token = bytes.toString("utf8").trimEnd();
          requireObservation(/^ghs_[A-Za-z0-9_.-]+$/.test(token));
        } finally {
          bytes.fill(0);
        }
        const observation = await observeTeam(target, token, signal);
        const present = await observation.roster();
        const confirmedAbsentSubjects: string[] = [];
        for (const id of new Set(previouslyGrantedSubjects)) {
          if (present.has(id)) {
            continue;
          }
          // A cursor walk can omit a current member. Resolve every prior grant
          // individually before returning any withdrawals from this observation.
          if ((await observation.subject(id, false)) === "present") {
            present.add(id);
          } else {
            confirmedAbsentSubjects.push(id);
          }
        }
        signal.throwIfAborted();
        return { status: "complete", presentSubjects: [...present], confirmedAbsentSubjects };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}
