# Policy inspector and tester

Use **Pages / Agent detail** to inspect the selected version's intended policy,
simulate a network request or plugin tool, and inspect individual rule results.
All Storybook snapshots, logs and responses below are controlled fixtures. They
do not evaluate a real policy, contact a Sandbox, or execute an action.

- **Network policy: inspect observed decision** opens a sanitized Sandbox log.
  Compare the historical observation with **OCE intended policy** from the current
  Sandbox Driver configuration; the selected version does not freeze that policy. The snapshot does not establish the policy that produced the log. Supply the full
  executable path, which the logged basename cannot verify.
- **Network policy: denied action**, **allowed action**, **audit decision** and
  **unknown simulation** show explicit simulated outcomes, individual rule
  matches, and checks outside simulation. The built-in default deny remains
  visible beside authored rules.
- **Policy tester: plugin tool without Sandbox** opens from the version's
  **Policy tester** tab. Inspect the plugin default and explicit tool override,
  then simulate the disabled Diffs tool. Switch action types to check the
  unsupported network state. Plugin tests need no log read or running Sandbox.
- **Policy tester: separate native evidence** first simulates intended policy,
  then explicitly reads and evaluates the Sandbox provider. The native snapshot
  and result remain separate from OCE simulation. They do not prove connectivity
  or replay the historical log.
- **Network policy: access denied**, **unavailable evaluator**, **loading** and
  **no log action** exercise denied access, unsupported simulation, pending
  snapshot reads, and manual input without log records.

At 390px, verify input labels, hashes and result reasons remain readable. Editing
inputs or changing action type clears previous results. Close with Escape and
confirm focus returns to the button that opened the dialog.

The browser suite exercises the actual Console, controller, IAM and OCE
simulator. Its network fixture supplies an authored policy description, while
plugin tests use the bundled Driver's admitted Diffs policy and tool inventory.
Native fixture responses verify presentation only; native runtime enforcement
requires separate provider proof.
