import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";

export const REPOSITORY_CLIENT_BIN = "/opt/oce/repository-credentials/bin";

const REPOSITORY_REST_SKILL = "github-repository-rest";
const REPOSITORY_REST_SKILL_DIRECTORY = `/usr/local/lib/oce/skills/${REPOSITORY_REST_SKILL}`;

function object(
  value: OpenClawConfigurationValue | undefined,
  path: string,
): OpenClawConfigurationDocument {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Repository credentials require ${path} to be an object.`);
  }
  return value as OpenClawConfigurationDocument;
}

function projectExec(
  value: OpenClawConfigurationValue | undefined,
  inheritedPaths: OpenClawConfigurationValue | undefined,
  path: string,
): OpenClawConfigurationDocument {
  const exec = object(value, path);
  const paths = exec.pathPrepend === undefined ? inheritedPaths : exec.pathPrepend;
  if (
    paths !== undefined &&
    (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(
      `Repository credentials require ${path}.pathPrepend to be an array of strings.`,
    );
  }
  return {
    ...exec,
    pathPrepend: [
      REPOSITORY_CLIENT_BIN,
      ...(paths ?? []).filter((entry) => entry !== REPOSITORY_CLIENT_BIN),
    ],
  };
}

function projectAgent(
  value: OpenClawConfigurationValue,
  inheritedPaths: OpenClawConfigurationValue | undefined,
  path: string,
): OpenClawConfigurationDocument {
  const agent = object(value, path);
  const tools = object(agent.tools, `${path}.tools`);
  if (tools.exec === undefined) {
    return agent;
  }
  // Agent pathPrepend replaces the global list, so preserve its effective inheritance.
  return {
    ...agent,
    tools: {
      ...tools,
      exec: projectExec(tools.exec, inheritedPaths, `${path}.tools.exec`),
    },
  };
}

export function repositoryNativeConfiguration(
  configuration: OpenClawConfigurationDocument,
): OpenClawConfigurationDocument {
  const tools = object(configuration.tools, "tools");
  // Native gateway exec prepends the login-shell PATH before applying this setting.
  const exec = projectExec(tools.exec, undefined, "tools.exec");
  const agents = object(configuration.agents, "agents");
  // The roster is agents.entries. Any agents.list passes through untouched, and
  // validateHarnessAuth then refuses every list the Gateway rejects.
  const entries =
    agents.entries === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(object(agents.entries, "agents.entries")).map(([id, value]) => [
            id,
            projectAgent(value, exec.pathPrepend, "agents.entries entry"),
          ]),
        );
  return {
    ...configuration,
    tools: { ...tools, exec },
    ...(entries === undefined ? {} : { agents: { ...agents, entries } }),
  };
}

function replaceGitHubSkillSelection(
  configuration: OpenClawConfigurationDocument,
): OpenClawConfigurationDocument {
  const skills = configuration.skills;
  if (!Array.isArray(skills)) {
    return configuration;
  }
  return {
    ...configuration,
    skills: [
      ...new Set(
        skills.map((name) =>
          typeof name === "string" && name.trim() === "github" ? REPOSITORY_REST_SKILL : name,
        ),
      ),
    ],
  };
}

/** Replace the generic GitHub instructions, which recommend commands outside the Repository policy. */
export function repositoryRestSkillConfiguration(
  configuration: OpenClawConfigurationDocument,
  publicationAllowed: boolean,
): OpenClawConfigurationDocument {
  const skills = object(configuration.skills, "skills");
  const entries = object(skills.entries, "skills.entries");
  const github = { ...object(entries.github, "skills.entries.github"), enabled: false };
  if (!publicationAllowed) {
    return {
      ...configuration,
      skills: {
        ...skills,
        entries: {
          ...entries,
          github,
          [REPOSITORY_REST_SKILL]: {
            ...object(entries[REPOSITORY_REST_SKILL], `skills.entries.${REPOSITORY_REST_SKILL}`),
            enabled: false,
          },
        },
      },
    };
  }
  const load = object(skills.load, "skills.load");
  const extraDirs = load.extraDirs ?? [];
  if (!Array.isArray(extraDirs) || extraDirs.some((dir) => typeof dir !== "string")) {
    throw new Error(
      "Repository credentials require skills.load.extraDirs to be an array of strings.",
    );
  }
  const agents = object(configuration.agents, "agents");
  return {
    ...configuration,
    skills: {
      ...skills,
      load: { ...load, extraDirs: [...new Set([...extraDirs, REPOSITORY_REST_SKILL_DIRECTORY])] },
      entries: { ...entries, github },
    },
    agents: {
      ...agents,
      ...(agents.defaults === undefined
        ? {}
        : { defaults: replaceGitHubSkillSelection(object(agents.defaults, "agents.defaults")) }),
      ...(agents.entries === undefined
        ? {}
        : {
            entries: Object.fromEntries(
              Object.entries(object(agents.entries, "agents.entries")).map(([id, agent]) => [
                id,
                replaceGitHubSkillSelection(object(agent, "agents.entries entry")),
              ]),
            ),
          }),
    },
  };
}
