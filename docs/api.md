# HTTP API

All application routes are under `/api`. Browser authentication uses the `copilot_web_session` HttpOnly cookie. Mutating routes require the `X-CSRF-Token` returned by `GET /api/me`.

`/audit/status` reports only whether the audit page is enabled. The conversation routes additionally require the signed-in GitHub login to appear in `audit.admins` in the repository config.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/auth/providers` | List configured GitHub hosts |
| GET | `/auth/:provider/login` | Begin OAuth |
| GET | `/auth/:provider/callback` | Complete OAuth |
| POST | `/auth/logout` | Revoke the web session and stop active turns |
| GET | `/me` | Current user and CSRF token |
| GET | `/audit/status` | Whether the audit page is enabled |
| GET | `/audit/sessions` | List every conversation for a signed-in `audit.admins` user. `404` when audit is disabled, `403` when the login is not listed |
| GET | `/audit/sessions/:id` | Read one conversation, including messages, for a signed-in `audit.admins` user |
| GET | `/repositories` | Enabled repository metadata and skills |
| GET | `/models` | Models available to the current Copilot identity |
| GET/POST | `/sessions` | List or create conversations |
| GET/PATCH/DELETE | `/sessions/:id` | Read, rename/configure, or permanently delete |
| POST | `/sessions/:id/messages` | Queue a turn; requires `Idempotency-Key` |
| POST | `/sessions/:id/stop` | Stop queued or running turns and local processes |
| GET | `/sessions/:id/events` | Replayable SSE stream; accepts `Last-Event-ID` or `after`. One process-wide poll fans out to connections. |
| POST | `/internal/events/notify` | Worker wake-up for the event hub. Requires the worker control token. |
| POST | `/sessions/:id/permissions/:requestId/respond` | `approve-once` or `deny` |

Session deletion is synchronous with SDK-state cleanup. It returns `503` rather than deleting database history if the Worker cannot confirm SDK-state deletion.

`GET /sessions/:id` includes turn summaries. `timed-out` and `interrupted` are terminal: the worker does not start those turns again. `TURN_TIMEOUT_MS` controls when a running turn becomes `timed-out`.
