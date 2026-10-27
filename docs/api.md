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
| POST | `/sessions/:id/secure-forms/:formId/submit` | Submit the current secure-form step. Requires the session owner and `X-CSRF-Token`. The response is `{ status, currentStep, stepId }` and does not echo field values. |
| POST | `/sessions/:id/secure-forms/:formId/cancel` | Cancel a pending secure form. Requires the session owner and `X-CSRF-Token`. |
| POST | `/internal/secure-forms` | Create a secure form for the session's active turn. Worker or sandbox bearer token. |
| GET | `/internal/secure-forms/:id?sessionId=` | Read secure-form metadata. No field values. |
| POST | `/internal/secure-forms/:id/claim` | Single-use claim of every submitted step. Response contains values and is `Cache-Control: no-store`. |
| POST | `/internal/secure-forms/:id/claim-step` | Single-use claim of one already submitted step. |
| POST | `/internal/secure-forms/:id/cancel` | Cancel one pending form. |
| POST | `/internal/secure-forms/:id/expire` | Expire one pending form. |
| POST | `/internal/secure-forms/cancel` | Cancel pending forms for a session or turn. |
| POST | `/internal/secure-forms/discard` | Drop unclaimed values from API memory. |
| POST | `/secure-form/deliver` on the sandbox runner | Claim values and write them to a command's stdin. Requires `SANDBOX_RUNNER_TOKEN`. |

Session deletion is synchronous with SDK-state cleanup. It returns `503` rather than deleting database history if the Worker cannot confirm SDK-state deletion.

`GET /sessions/:id` includes turn summaries. `timed-out` and `interrupted` are terminal: the worker does not start those turns again. `TURN_TIMEOUT_MS` controls when a running turn becomes `timed-out`. `MAX_TOOL_ROUNDS_BEFORE_CONFIRM` (default 50) pauses a turn after that many tool rounds and asks the user to continue or stop. Stop, or no answer before `APPROVAL_TIMEOUT_SECONDS`, marks the turn `stopped`.
