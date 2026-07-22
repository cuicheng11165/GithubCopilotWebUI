# HTTP API

All application routes are under `/api`. Browser authentication uses the `copilot_web_session` HttpOnly cookie. Mutating routes require the `X-CSRF-Token` returned by `GET /api/me`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/auth/providers` | List configured GitHub hosts |
| GET | `/auth/:provider/login` | Begin OAuth |
| GET | `/auth/:provider/callback` | Complete OAuth |
| POST | `/auth/logout` | Revoke the web session and stop active turns |
| GET | `/me` | Current user and CSRF token |
| GET | `/repositories` | Enabled repository metadata and skills |
| GET | `/models` | Models available to the current Copilot identity |
| GET/POST | `/sessions` | List or create conversations |
| GET/PATCH/DELETE | `/sessions/:id` | Read, rename/configure, or permanently delete |
| POST | `/sessions/:id/messages` | Queue a turn; requires `Idempotency-Key` |
| POST | `/sessions/:id/stop` | Stop queued/running turns and sandboxes |
| GET | `/sessions/:id/events` | Replayable SSE stream; accepts `Last-Event-ID` |
| POST | `/sessions/:id/permissions/:requestId/respond` | `approve-once` or `deny` |

Session deletion is synchronous with SDK-state cleanup. It returns `503` rather than deleting database history if the Worker cannot confirm SDK-state deletion.
