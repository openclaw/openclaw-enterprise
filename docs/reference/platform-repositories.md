# Platform repository transactions

The memory and PostgreSQL implementations of `PlatformStateStore` bind every
repository handle to one `read` or `transact` callback. The controller uses this
boundary for resource mutations and audit records; the worker shares it with
its durable work queue.

## Caller contract

Await repository results inside the callback. Once the callback settles, its
handles reject new calls. The owner waits for complete operations accepted
before that point, including internal asynchronous lookups, before committing
or rolling back. Draining does not make an unobserved operation failure a
successful result; callers must await and handle those results.

A `read` callback receives a frozen projection containing only read methods.
It does not expose mutation or row-lock methods at runtime. Repository results
are immutable copies. Retaining a read view or unit of work after the callback
does not extend its lifetime; start a new callback to read or change state.

## Ownership and atomicity

One owner controls each transaction. Resource writes, audit records, and queued
controller work commit together. A failed callback rolls them back and closes
its handles. The memory store publishes its working snapshot only after accepted
operations finish and audit publication succeeds.

PostgreSQL repositories, transaction queries, and the worker's queue use the
same borrowed client. Only the state owner begins, commits, rolls back, and
releases that client. Accepted operations finish before release, and escaped
queue or query handles cannot access it afterward. An uncertain commit outcome
continues to suppress unsafe controller compensation.

These are persistence boundaries; they do not authorize a resource operation.
The controller and worker still enforce the caller's exact resource authority.

See [PostgreSQL testing](../testing/postgresql.md) for contributor setup and
[controller reconciliation](controller.md) for worker behavior.
