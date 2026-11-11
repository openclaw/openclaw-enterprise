---
rfc: ../rfcs/0034-native-telegram-polling.md
---

# Implementation plan: Telegram as a primary Agent channel

- **ID:** RFC-0034
- **Delivery status:** In progress
- **Owner:** uggy-ug
- **Authority:** [RFC-0034](../rfcs/0034-native-telegram-polling.md)
- **Source baseline:** Enterprise `6e91c9d`, with a local backport to `54bfa7f`

## Outcome and scope

Qualify the native Telegram channel for the private-chat capabilities and
failure recovery defined by RFC-0034. Keep the bundled plugin and dedicated
Harness topology. Use the operator's authorized bot for live checks.

## Contract and source touchpoints

Kubernetes Compute admits the channel, renders Gateway credentials and proxy
access, and observes the selected Agent revision. The selected Sandbox Driver
owns provider supervisor recovery. OpenClaw owns message ingress, native
commands, sessions, media preparation, and Telegram delivery.

Inspect the configured OpenClaw source pin before changing runtime behavior.
Resolve media transport through the existing file-transfer/workspace path.
Select transcription from the native media backend contract, preserving the
Gateway and Harness credential boundary.

## Implementation

1. Inspect the actual Telegram command and media configuration and compare
   the pinned native implementation with observed client behavior.
2. Exercise commands and marked document/image transfers. Fix the owning
   configuration or transport path for each reproducible failure.
3. Configure an available transcription backend and verify an actual voice
   message. Record any credential or runtime dependency that remains missing.
4. Enable the native progressive-reply mode and verify successive client states.
5. Reproduce Gateway failure and loss of the provider supervisor. Add recovery
   through the existing owning lifecycle, with retry serialization and stopped
   Agent protection. Verify delivery of a queued message after recovery.
6. Extend the regular Agent QA scenario and register inputs and selection.
   Update current reference, flow, and testing documentation with observed limits.

## Verification

| Criteria | Required proof                                                            | Result                                 |
| -------- | ------------------------------------------------------------------------- | -------------------------------------- |
| AC-1     | Private chat and real dedicated model response                            | Observed locally                       |
| AC-2     | API refusal, Secret scope, allowed and denied network probes              | Partial local proof                    |
| AC-3     | Git replacement, exclusive polling, and rollback                          | Replacement observed, rollback pending |
| AC-4     | Native commands through Telegram                                          | Pending                                |
| AC-5     | Inbound and outbound attachment contents                                  | Pending                                |
| AC-6     | Known voice phrase, transcript, and response                              | Pending                                |
| AC-7     | Successive visible response states                                        | Pending                                |
| AC-8     | Automatic Gateway and supervisor recovery, queued reply, intentional stop | Pending                                |

## Delivery record

Native private chat and deployment isolation were observed in an operator's
local installation. Loss of the provider supervisor suspended the Harness and
prevented Telegram channel startup. A manual deployment recovered the Agent and
delivered its queued message. This does not establish automatic recovery.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-11: Extend qualification to commands, media, voice, progressive delivery,
  and automatic recovery. Source baseline `6e91c9d`.
