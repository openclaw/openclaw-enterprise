# Test Kubernetes Agent management

Run the API, PostgreSQL and real Kubernetes cases for their distinct boundaries.
None alone proves Git polling, a genuine model turn or Telegram delivery.

| Test                                         | Exercises                                                                                         | Does not prove                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `external-agent-management.test.ts`          | Production Fastify, OCC, Native IAM, adoption, conflicts, manual stop, release and repeated apply | PostgreSQL or deployed runtime     |
| `postgres-agent-external-management.test.ts` | Production API/authentication, PostgreSQL constraints, persisted ownership and apply receipt      | Genuine runtime or Argo            |
| `operator-kubernetes-real.test.ts`           | Real Kubernetes SDK, CRD schemas, watches, Lease, TLS and scoped Enterprise identity              | Genuine model or Argo              |
| QA `external-management`                     | Shipped installation, existing Agent adoption, update, revision convergence and release           | Kubernetes Operator or Git polling |

Run the first test with the repository's supported Node version:

```sh
node --test tests/integration/external-agent-management.test.ts
```

Use the [PostgreSQL fixture workflow](postgresql.md) for the database test.
Select an owned disposable loopback k3d cluster through
`OCC_TEST_KUBERNETES_KUBECONFIG` and `OCC_TEST_KUBERNETES_CONTEXT`, then set
`OCC_TEST_KUBERNETES_OPERATOR=1` to run the SDK case. The test installs the four
CRDs and removes only its generated namespace. Missing selected infrastructure
fails; an unselected case skips explicitly.

The schema qualification includes fresh migration, logical restore and a
populated older database upgrade. PostgreSQL can flatten equivalent CHECK
expression parentheses during logical restore. Accepted catalog aliases must
come from measured restore/upgrade paths; do not loosen catalog verification
or accept a changed function or grant to make an upgrade pass.

For full Argo proof, use an owned installation and private test repository with
a read-only deploy key. Follow the [setup guide](../guides/kubernetes-agent-gitops.md).
Record the source and Git commit, Argo sync/health, Configuration generation,
requested/active revision, runtime observation, duplicate checks after Operator
restart, Git rollback, Retain prune and real channel behavior. Test stale health
by stopping only the owned Operator. Preserve service keys, OAuth material,
bot tokens and private user identifiers outside evidence and Git.

RFC-0037's first-time creation, credential import/rotation and Delete cleanup
remain unimplemented and unqualified. The alpha's existing-resource proof must
not be reported as completion of those acceptance criteria.
