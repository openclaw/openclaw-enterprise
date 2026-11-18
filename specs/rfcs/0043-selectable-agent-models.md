---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# RFC-0043 · Select several models for an Agent

An Agent creator can choose a default model and additional models from the same provider. For example, a team can deploy an Agent with a small model as its default and choose a larger model for one chat session. Both models use the same Harness, inference endpoint and credential. [RFC-0034](0034-reusable-model-providers/index.md) describes how an administrator publishes the models a provider offers.

## Configuration and deployment

Create Agent writes the default to `agents.defaults.model`. It records the switchable models, including the default, in the native `agents.defaults.modelPolicy.allow` list. Each selected ID has a Harness policy under `agents.defaults.models` and a model entry for that provider. Choosing another model for a session leaves the default for other sessions intact. Automatic fallback remains an independent Configuration setting.

OCC admits catalog entries for explicitly selected model IDs alongside the primary and fallback models it already admits. The selected models must use the same provider and Harness. When an Agent uses a saved provider, each selected ID must occur in its catalog. Deployment saves the selections and their admitted metadata in the Agent revision.

Compute supplies the selected models and their metadata to the native runtime. Dedicated OpenClaw uses this catalog for model selection and session switching. All models backed by the selected credential must use its approved destination. The generic CredentialProxy contract does not require model-ID checks. The existing protected inference profile continues to check its own model grant, which includes the selected session models.

## Verification

Deploy an Agent with two model IDs on one provider. Check that a new session uses the default, switch to the other model for a turn, and confirm another new session still uses the default. Exercise admission with a model on a different provider, an unselected catalog row and a second model with a conflicting destination. Each should fail before activation.

The [Create Agent form](../../docs/reference/console/create-and-deploy.md) and [Harness model selection](../../docs/reference/harness-execution.md#native-runtime-selection) implement these choices on this branch. Integration covers deployment admission and the credential destination check. A tool-call turn after a session switch still needs qualification.
