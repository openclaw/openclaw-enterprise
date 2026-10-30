# Organize and name development docs

Use this guidance when planning navigation or adding, combining, moving, or
renaming product, operator, or contributor documentation. Check `AGENTS.md`,
`docs/layout.md`, and `docs/docs.json` for file ownership and the current map.
When changing navigation, update the owning indexes and incoming links in the
same change. Preserve working paths, routes, and anchors; a shorter label does
not require a new URL.

## Organize around the reader's task

A menu selects a sidebar; a sidebar group supplies context; each page answers
one coherent question or helps complete one task. Organize around reader intent,
not the code tree. Keep the starting path first and ongoing work separate from
first-time setup.

| Section          | What belongs there                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Getting Started  | Orientation, concepts, setup, and the first successful use.                                                                  |
| Topics           | Product concepts, feature behavior, configuration, and feature troubleshooting that do not belong to a named implementation. |
| Integrations     | Named Drivers, Providers, or channels; their setup, support limits, and comparisons.                                         |
| Deploy & Operate | Production installation and ongoing work: monitoring, platform troubleshooting, credentials, upgrades, and recovery.         |
| Reference        | Exact CLI and HTTP API contracts: commands, flags, requests, responses, and errors.                                          |
| Contribute       | Work on the platform itself: Design, Local Development, Repository Layout, and Documentation.                                |

The first page in each menu should orient readers to the whole section, not
drop them into one category. Put prerequisites before the steps that need them;
for example, local platform setup precedes deploying a first Agent. Keep existing
audiences clear: the first five menus serve product users and operators, while
Contribute serves people changing the platform.

Give each subject one owning page and link to it from other useful locations.
For example, explain Sandbox in Topics; keep OpenShell setup in Integrations
and link to it. Put base Driver contracts under contributor Design in site
navigation without moving the source files to match the menu. Link deep runtime
flows and code-testing guides from contributor indexes; register them as hidden
if individual pages would crowd the sidebar. Historical specs belong behind an
index of past designs. `docs/testing/` owns code verification, not documentation
authoring. Do not publish an unfinished or unverified workflow as normal guidance.
Keep known limitations prominent on the page for a documented feature.

## Name pages for their context

- Use short, familiar sidebar labels, usually one to four words. When the
  group already names the subject, use `Overview`, `Quickstart`, `Configure`,
  or `Troubleshoot`. Keep a specific noun when it distinguishes nearby pages:
  `Local Setup`, `Audit Log`, `Service API Keys`, `Agent Revisions`, or
  `Driver Development`. Put explanations in the introduction or section headings.
- Use Title Case for sidebar labels, preserving product names and acronyms such
  as Agent, IAM, CLI, and HTTP API. Write article titles and section headings
  in sentence case; add context for someone arriving from search or a direct
  link, for example `IAM overview` or `Troubleshoot Agents`. Write `Quickstart`
  and `Troubleshoot` as one word; use `Setup` as a noun and `Set up` as a verb.
- Set a short sidebar label with the navigation page object's `label` field.
  The Markdown H1, or optional frontmatter `title`, still provides the article
  or browser title; keep both descriptive if frontmatter is present. Navigation
  nesting can supply context for labels, but must not make article titles
  ambiguous outside the sidebar. Do not shorten or rename a published heading
  in a way that breaks an existing anchor.
- Combine a workflow and reference when they cover the same resource for the
  same reader and fit on one useful page. For example, `Service API Keys` can
  hold issue/revoke instructions, permissions, and reference details under
  distinct headings. Split when audiences or tasks are independently useful,
  or when repository length rules call for it. Give sibling pages distinct names.
  Put status and caveats near the opening instead of in the sidebar label.

## Register a page in navigation

Add each Markdown page under `docs/` to one menu in `docs/docs.json`. Within a
group, `pages` accepts a slug, an object with `page` and `label`, or a nested
group with its own `pages`. Slugs are source paths relative to `docs/`, without
`.md`. For example:

```json
{
  "tab": "Contribute",
  "groups": [
    {
      "group": "Design",
      "pages": [
        { "page": "ARCHITECTURE", "label": "Architecture" },
        {
          "group": "Internals",
          "pages": [{ "page": "contributing/runtime-flows", "label": "Runtime Flows" }]
        }
      ]
    }
  ],
  "hidden": ["flows/platform-startup"]
}
```

Use a tab's `hidden` list for pages discoverable through an owning index but not
useful enough as individual sidebar entries. They retain their routes and search
entries. Cross-link shared topics in Markdown instead of registering a page under
several menus. Avoid adding a group around a single page unless that grouping
clarifies a deliberate task sequence. A page must never be reachable only through
search: link it from its owning overview or contributor index.
