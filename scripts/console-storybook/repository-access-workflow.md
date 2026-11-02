# Repository collaborator access

Build from the repository root with `pnpm storybook:install` and
`pnpm storybook:build`. Serve `scripts/console-storybook/dist/site` on loopback,
for example with `python3 -m http.server 6006 --bind 127.0.0.1 --directory
scripts/console-storybook/dist/site` (on one line).

Open these maintained stories under **Pages / Agent detail**:

| Story ID                                                | Fixture scenario                 | Check                                                          |
| ------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| `pages-agent-detail--repository-collaborator`           | `repositoryCollaborator`         | Select from an empty set and save collaborator access.         |
| `pages-agent-detail--repository-collaborator-saved`     | `repositoryCollaboratorSaved`    | Saved inheritance stays unchanged across delayed discovery.    |
| `pages-agent-detail--repository-collaborator-read-only` | `repositoryCollaboratorReadOnly` | Explicit Read-only requires an explicit collaborator override. |

Use `/?path=/story/<story-id>` for the Storybook wrapper or
`/storybook-fixtures/frame.html?story=<scenario>` for its standalone preview.
The preview replaces its URL with the Console route after loading; reload the
fixture URL, or use **Reset story**, to reset its in-memory state.

The shared catalog offers `example/application` as collaborator-only Git access,
`example/handbook` as Read-only, and an API-only entry that must not appear in
Git repository choices. The existing `RepositoryEditor` and loading/refusal
stories retain their older profile fixtures.

## Positive and negative checks

1. In the empty story, confirm no selected repositories and a Contributor Agent
   default. Select application through its checkbox. Save repository access;
   the request must keep `defaultProfile: "git-full"` and explicitly select
   `{ repositoryRef: "application", profile: "github-repository" }`. Confirm
   the saved message and selection after visiting Channels and returning.
   API-only must not be selectable.
2. In the saved story, observe the three-second loading interval and **Access
   awaiting verification**. Discovery must not rewrite the inherited selection,
   send a PATCH, or make Channels unavailable. Once discovery completes,
   **Choose approved access** appears and Save remains disabled. Clear **Use
   Agent default** for application and choose **Repository collaborator**.
   Only this explicit edit permits saving collaborator access.
3. The Read-only story operates the default radio and repository checkbox through
   the real UI. Confirm Read-only remains selected and Save is disabled. Choose
   an explicit collaborator override: Save succeeds while the default stays
   `git-read`. Reset; remove application and select handbook instead. Saving
   must preserve inherited Read-only, without a collaborator override.

Inspect requests in browser developer tools when available, or use
`window.__consoleStory.requests` for method/path evidence. The in-memory fetch
fixture is not a network backend. These stories prove rendered UI behavior with
simulated API data, not Controller persistence, authorization, or runtime Git
access. Existing `tests/browser/console-agent-repositories.test.ts` cases cover
explicit Read-only, fresh collaborator selection, and saved inheritance through
the Controller fixture.
