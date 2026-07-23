# Storage

GithubCopilotWebUI uses SQLite as its only application database and coordination store.

| Data | Location |
| --- | --- |
| Users, encrypted GitHub tokens, and web login Sessions | `data/copilot.db` |
| Conversations, turns, messages, approvals, SSE events, and audit logs | `data/copilot.db` |
| Copilot SDK Session state | `data/copilot/` |
| Local execution temporary files | `data/local-sandbox/` |
| Repository contents and skills | The live configured repository directory |

## Database behavior

Configure the database with a SQLite URL:

```dotenv
DATABASE_URL=file:../../../data/copilot.db?connection_limit=1
```

SQLite runs in WAL mode with foreign keys enabled, one connection per process, and a ten-second busy timeout. The API and Worker share the same database file. Queued `Turn` rows are atomically claimed by the Worker; approval, cancellation, restart recovery, same-Session serialization, and replayable event delivery are all driven by database state.

The default Worker concurrency is two. SQLite serializes writers, so increase concurrency only after measuring the actual workload. Run only one Worker process and do not place the database on NFS or another network filesystem.

Create or update the database with:

```bash
pnpm db:migrate
```

## Backup and restore

For a consistent offline backup, stop the API and Worker and copy these files together:

```text
data/copilot.db
data/copilot.db-wal
data/copilot.db-shm
data/copilot/
```

SQLite may remove the `-wal` or `-shm` files when they are not needed. Their absence after a clean shutdown is normal. When services must remain online, use a SQLite-aware online backup tool instead of copying only the main database file.

Restore the database files and Copilot state directory to their original paths, run `pnpm db:migrate`, and then start GithubCopilotWebUI.
