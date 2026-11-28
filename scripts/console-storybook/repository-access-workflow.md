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

## Leave an unsaved selection

In the standalone Repository Collaborator preview, open **Channels**, then
return to **Repositories**. Select `example/application` and scroll up until
the save actions are out of view. Press Back. The selection stays checked.
The explanation takes focus, with **Save repository access** and **Cancel**
in view. Press Shift+Tab to reach **Cancel**. Cancel the edit, then check
that Back opens **Channels**. Repeat at phone width.

## Positive and negative checks

1. In the empty story, confirm no selected repositories and a Contributor Agent
   default. Open **Configuration** and check that **Repository access** shows
   **None selected**. Return to **Repositories**, select application through
   its checkbox and save repository access. The request must keep
   `defaultProfile: "git-full"` and explicitly select
   `{ repositoryRef: "application", profile: "github-repository" }`. Confirm
   the saved message and selection after visiting Channels and returning.
   API-only must not be selectable.
2. In the saved story, observe the three-second loading interval and **Access
   awaiting verification**. Discovery must not rewrite the inherited selection,
   send a PATCH, or make Channels unavailable. Once discovery completes,
   **Choose approved access** appears and Save remains disabled. Clear **Use
   Agent default** for application and choose **Contributor**. Only this explicit
   edit permits saving collaborator access. Save, then choose **Account → Settings**
   during the ten-second Agent read. Repositories stays open with the edit selected
   and a wait message. After the saved message, open Settings and go back to confirm
   the custom collaborator access remains saved.
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

## Missing repositories

Open **Pages / Create Agent** in Storybook:

| Story ID                                    | Fixture scenario              | Check                                                      |
| ------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `pages-create-agent--repository-empty`      | `createRepositoriesEmpty`     | An empty catalog offers help and allows an ordinary draft. |
| `pages-create-agent--repository-no-matches` | `createRepositoriesNoMatches` | A search with no matches offers help.                      |

Both states direct you to your Namespace operator. In the search story, replace
the query with `application`. Matching repository choices return and the help
disappears. Compare with **Repository discovery pending** and **Repository
discovery denied**, which display their own status instead.

## Repository search keyboard

Open **Pages / Create Agent / Repository Exact Search**
(`pages-create-agent--repository-exact-search`). Search for `application` with
both exact matches unchecked. Press Down Arrow to focus `omega/application`,
then press Enter. The checkbox stays unchecked and focused, and the form stays
open. Press Space to select it. Reset the story and repeat the search.
The cue names `omega/application` as the next selection.
Press and hold Enter. Only `omega/application` becomes selected while the key
repeats, and the cue changes to `zeta/application`.

Release Enter and press Escape. Press Enter once to reopen the results. The cue
again names `zeta/application`. Release Enter and press it again to select that
repository. Search for `application-api`. Only `alpha/application-api` matches.
The search hint shows **2 selected in total** and names that repository as the
next selection. Return to `application` and check at phone width that you can
read the next name below the search field even when its row is out of view.
Select the last two matches. The field now reports **4 selected**.

Reset the story and search for `application` at phone width. The hint starts
with **In search, Enter selects**. Use Down Arrow and Up Arrow to move through
the results. Check that you can read the full name of each focused repository
above the Create Agent buttons.

Reset the story and use Enter to commit text with an input method in the search
field. Committing text must neither select a repository nor submit the form.
These checks change the unsaved selection. They do not save the form, create an
Agent, or grant runtime repository access.

Reset the story. Choose **Service Accounts** under **Authentication method**
and leave **Service account token Secret** empty. Enter `gpt-4.1` as the model ID.
Under **Default repository access**, tab to **Contributor** and press Enter.
Focus and selection stay on **Contributor**. Use the arrow keys to select
**Read-only** and then **Contributor** again. Press Enter on **Customize access**
to open it. Tab to **Create and manage issues** and press Enter. The checkbox
stays checked and focused. Press Space to uncheck it. Press Enter on
**Create Agent** and check that focus moves to the missing token field.

## First-deployment warning

Open **GitHub repository access** under **Pages / Create Agent**
(`createGitHubRepositoryGrants`). The story starts with two repositories
selected. Change one from **Read/write Git** to **Read-only Git** and back.
Check that the hint describes public metadata reads without credentials and
the additional requirements for opening pull requests. Choose a registered
**GitHub App Client** before saving the draft. The
Client and selected repository access are saved on the Agent; the Console does
not create a GitHub credential Source. Uncheck both. Before **Create Agent**,
check the warning about deployment without a repository policy. Select a repository
again. The warning disappears and **Save Agent draft** returns. **Access profiles**
retains its existing hint. Open **GitHub repository access with a registered App**
(`createGitHubClient`) to inspect the selected application repository. The
**GitHub App Client** list offers the Installation-wide Client and the Client
registered in Engineering. Select **Engineering repository App** and save the
draft. This story simulates the Console. It does not mint a token or deploy a
Source.

Open **Set permissions on a saved draft** under **Pages / Agent detail**
(`repositoryPermissionsDraft`). Read the conditional warning before **Deploy new
version**, then follow **Set repository permissions**. This story has a profile
binding and simulated policy data; it does not cover an empty-binding draft or a
confirmed deny-all policy. Neither story establishes real deployment, policy
persistence, authorization, or runtime repository access.
