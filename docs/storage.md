# Storage modes

CopilotDeck separates durable application records from runtime coordination and Copilot SDK state.

| Data | Local mode | Multi-user mode |
| --- | --- | --- |
| Users, encrypted GitHub tokens, web sessions | `data/copilot.db` | PostgreSQL |
| Conversations, turns, messages, approvals, SSE events, audit logs | `data/copilot.db` | PostgreSQL |
| Copilot SDK session state | `data/copilot/` | `copilot-state` Docker volume |
| Queues, locks, cancellation and Pub/Sub | Redis | Redis |
| Repository contents and skills | Live read-only mount | Live read-only mount |

## Local mode

Set:

```dotenv
DATABASE_MODE=local
DATABASE_URL=file:../../../data/copilot.db?connection_limit=1
COPILOT_HOME=./data/copilot
```

SQLite runs in WAL mode with foreign keys enabled, one connection per process, and a ten-second busy timeout. The API and Worker share the same database file. Local Compose defaults to two Worker jobs because SQLite serializes writers. This mode is not suitable for application replicas on different hosts or for a database file on NFS/network storage.

Create or update the database with:

```bash
pnpm db:migrate:local
```

For a consistent offline backup, stop the API and Worker and copy `copilot.db`, `copilot.db-wal`, `copilot.db-shm`, and the `copilot/` directory together. Alternatively, use a SQLite online-backup tool while services remain active.

## Multi-user mode

Set:

```dotenv
DATABASE_MODE=multi-user
DATABASE_URL=postgresql://user:password@host:5432/copilot
```

Apply PostgreSQL migrations with:

```bash
pnpm db:migrate:multi-user
```

Use this mode when multiple application replicas, heavier concurrent streaming, managed backups, or operational database tooling are required.

## Moving between modes

Changing `DATABASE_MODE` does not migrate data. The SQLite and PostgreSQL schemas represent the same application entities, but use different physical types for enums, approval scopes, and event cursors. Stop all application services and use an explicit export/import process that preserves IDs and relationship order. Back up both stores first; do not point the wrong mode at an existing database URL.
