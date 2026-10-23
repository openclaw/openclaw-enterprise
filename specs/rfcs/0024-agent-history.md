---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# RFC-0024: Agent History

An on-call operator finds an Agent offline. Who last changed it? Did someone stop it, or did a deployment fail? Add **History** to the Agent's Console page and expose the same bounded, paginated view through the controller API. A reader with an explicit audit grant can see who requested a create, update, deploy or stop, what the controller accepted, and what the system observed for that operation.

## What appears in History

The [Agent API](../../apps/controller/src/http/agents.ts) already records mutations. Create and update commit a change to the Agent definition. Deploy admits a revision and stop accepts work. Both return HTTP 202. The [worker](../../apps/controller/src/worker.ts) separately records revision activation, supersession and stop outcomes. History projects those facts from the existing audit ledger. When a producer lacks a durable fact needed for History, that producer records it alongside the state transition it owns.

| Action           | Accepted change                              | What the reader can conclude                                                                                                              |
| ---------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Create or update | The controller committed the definition.     | The Agent was created or updated. Saving a definition does not start it.                                                                  |
| Deploy           | The controller admitted a specific revision. | The worker may later report it active, failed, or superseded. Another revision becoming active does not establish this attempt's outcome. |
| Stop             | The controller accepted a stop request.      | Show stopped when the worker confirms shutdown. Show a refused, failed or superseded attempt with its recorded outcome.                   |

Each entry identifies the action, recorded time, target Agent and revision when applicable, requester, and source of the observation. A worker carrying the requester's identity reports the observation as the worker. Keep the requester as recorded at admission. If the identity or final outcome cannot be established, show **unknown**. Show **pending** only while durable evidence identifies outstanding work. A recorded denial ends the request before admission.

Group facts by durable operation and attempt IDs within the recorded Namespace and Agent. Producers must preserve revision parentage across deletion. A worker retry adds an attempt to the same operation. A second user request is distinct. Never join by name, current owner or nearest timestamp. If the controller loses a reply after a possible commit, the operator looks up the original request and reconciles its recorded work. Reading or refreshing History cannot resubmit the action.

## Who can read it, and for how long

The controller requires a current, explicit `read_audit` grant for the exact Agent and recorded Namespace on every page, including continuations and reads by retained Agent ID after deletion. Ordinary Agent read, deploy rights and the Installation-wide grant in [RFC-0013](0013-platform-audit/index.md) grant no History access. Validate the recorded target before querying or disclosing rows. Refuse unverifiable parentage or expired authority without disclosing whether a deleted Agent existed. An authorized empty page means the query found no retained facts in its window. If the ledger cannot answer, show History unavailable. Return only typed lifecycle facts and safe reason codes. Exclude prompts, configuration contents, credential material and raw Driver errors.

State applies the Installation's retention policy to this view and its underlying facts. In retain-after-deletion mode, keep the minimum Agent identity and authorization context until expiry. In purge-on-deletion mode, withdraw access when deletion commits and track purge to completion. Expired or purged rows must stay inaccessible after restoring an older backup. Reconcile expiry and deletion records from outside that backup before enabling reads. If reconciliation cannot establish the applicable policy or deletion state, keep History closed.

## Acceptance

1. Create and edit an Agent, deploy two revisions, then stop it. An authorized reader can distinguish each requester, saved change, admitted revision and worker result in Console and API. Inject a failed deployment, retry and superseded stop. Each stays with its own attempt.
2. Drop the deploy reply after admission and withhold the terminal observation. The original request remains discoverable. Refresh performs no mutation and the final outcome stays unknown. An older record with no verified requester shows unknown attribution.
3. Grant History on one Agent and deny access to a sibling, an ordinary Agent reader and a platform auditor. Revoke the grant between pages. Inspect the returned fields for sensitive data and verify that denial discloses no rows.
4. Delete an Agent under each retention mode, expire a retained record, and restore a pre-deletion backup. Verify authorized retained lookup, completed purge, expiry and refusal while restore reconciliation is incomplete.

This first release ends with lifecycle History. Attributing a repository read to the person who asked an Agent to perform it requires evidence from the runtime and credential system and has separate acceptance criteria. [Original scope discussion](https://github.com/openclaw/openclaw-enterprise/pull/250#issuecomment-5754821713)
