# Clean up an interrupted production preflight

Use `scripts/upgrade-production-images --cleanup-preflight` from the original
source checkout to remove temporary Kubernetes resources recorded by an
interrupted [production image upgrade](production-upgrade.md). It checks the
original evidence, deletes acknowledged resources with UID preconditions, and
reports whether cleanup completed.

This command applies only to runs with a versioned `preflight-journal.json`. For
older or uncertain evidence, follow [manual reconciliation](#reconcile-unsupported-or-uncertain-evidence).
Never create a journal or fill missing receipts from current resource names.

## Prepare the cleanup

Keep one operator and any existing maintenance freeze. Preserve the original
private evidence directory and `.upgrade-lock`. Before proceeding:

1. Confirm the previous helper and its child processes stopped. Reconcile
   requests they may have submitted, including operations still running remotely.
   A stopped local process does not establish that an accepted request finished.
2. Confirm this is the original evidence directory, with its original files.
   Do not use a restored backup, replace the directory, or edit receipts to make
   validation pass. A backup can omit an already-started create.
3. Use the original checkout and unchanged helper files. Retain the original
   kubeconfig path and contents, context, namespace and release from
   `parameters.json`. Current credentials must still authorize the cleanup.

The command requires Python 3, Node.js, `jq`, `kubectl` and `mktemp`. Kubernetes
access must permit reading and deleting the recorded Jobs, Secrets and
NetworkPolicies, plus listing Pods and reading any recorded child Pod. No OCC
service key or candidate image is required. Cleanup does not run Helm, migrate
the database, scale workloads, create Kubernetes resources or dispatch Agents.

## Run cleanup against the original evidence

Replace the example paths and target values with the original run's inputs.
Run from the root of that checkout:

```bash
scripts/upgrade-production-images --cleanup-preflight \
  --kubeconfig /secure/occ/kubeconfig \
  --context '<original-context>' \
  --namespace openclaw-system \
  --release openclaw-enterprise \
  --evidence-dir /secure/occ/upgrade-evidence \
  --previous-process-settled \
  --evidence-unrestored
```

The last two flags attest that you completed the checks above. They do not stop
processes or detect a restored backup. Cleanup accepts only these target and
evidence arguments and the two attestations; do not add `--resume`,
`--preflight-only`, image, values or other upgrade arguments.

An exclusive process lock prevents overlapping use of the evidence directory.
The helper checks its recorded target and source bindings, every registered
preflight attempt, each creation plan, started markers and identity receipts
before accessing Kubernetes. Invalid evidence exits with code `2` without
attempting Kubernetes cleanup.

Each accepted invocation writes observations and a `preflight-cleanup-result.json`
under a fresh `preflight-cleanup.XXXXXXXX/` child directory. The command prints
the result's path. It keeps original receipts and earlier results unchanged.

| Result                                       | Meaning                                                                                  | Next action                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Exit `0`, `complete: true`                   | Every recorded resource requiring cleanup is confirmed absent, with no uncertain create. | Return to the [upgrade recovery procedure](production-upgrade-recovery.md).                                |
| Exit `1`, `complete: false`                  | A create is uncertain or resource cleanup could not be confirmed.                        | Inspect `unknown` and `preflight-cleanup.err` in this invocation's directory; reconcile before proceeding. |
| Exit `2`                                     | Inputs, lock acquisition or original evidence failed validation.                         | Correct the supported inputs, or follow manual reconciliation. Do not alter identity evidence.             |
| Interrupted invocation or no complete result | Cleanup has not been established.                                                        | Settle its processes and remote operations before any new attempt.                                         |

`complete: true` covers only temporary preflight Kubernetes resources. It does
not remove `.upgrade-lock`, resume an upgrade, prove release health, establish
migration outcomes or roll back the database. The release owner must finish
[partial-upgrade recovery](production-upgrade-recovery.md).

## Understand an incomplete result

Before a create can start, the helper saves a complete attempt plan and registers
it in the root journal, then saves that slot's started marker. A planned slot
without a started marker needs no cleanup. A started create without a valid
acknowledgement remains uncertain, even when no object currently has that name.

The helper can clean acknowledged Jobs while another create is uncertain. It
retains the candidate Secret and NetworkPolicy whenever a Job create is uncertain
or Job/child cleanup is unconfirmed. Any uncertain create prevents a complete
result. It never adopts a live object's UID to replace a missing acknowledgement.

Acknowledgements record the original kind, name and UID. A valid final receipt
in a journaled run remains usable if the original publisher failed after
publishing it: cleanup validates the complete evidence set and syncs its facts
before sending deletes. This rule does not apply to older, unjournaled runs.

Jobs are deleted with foreground propagation and UID preconditions. Their owned
and recorded child Pods must disappear before dependencies are removed. A failed
DELETE is settled only by a successful absence check. Accepted deletion alone is
insufficient; finalizers can delay removal. Polling allows 30 seconds per Job or
dependency. Read failures or changed UIDs prevent success, and replacements remain
untouched.

After resolving a transient Kubernetes failure, rerun the same cleanup command
with the original evidence and both truthful attestations. Already-absent
resources converge through fresh checks. Do not rerun creates or edit a missing
acknowledgement into place.

## Reconcile unsupported or uncertain evidence

Contact the release owner when a run lacks the versioned journal, evidence was
restored, or identities are missing, malformed, conflicting or uncertain.
Labels and names can locate candidates; they do not authorize deletion. Startup
resources use `app.kubernetes.io/instance=<release>` and
`app.kubernetes.io/component=upgrade-preflight`; migration Jobs use
`component=initialization`. Inspect `preflight-<resource>-create.err` for create
failures. Preserve all records and reconcile accepted requests without repeating
them.

Manual deletion requires an API-enforced `DeleteOptions.preconditions.uid` for
the original kind, namespace and name. Reading then deleting by name cannot
prevent replacement. Foreground-delete owned Jobs and confirm their children
are gone before deleting dependencies. Missing Job acknowledgements require
reconciling possible consumers; labels alone do not prove ownership.

For old unjournaled runs, failed or uncertain identity publication requires
manual reconciliation even when a file exists. A current successful GET cannot
repair the missing history. Return to upgrade recovery only after the release
owner resolves these uncertainties.
