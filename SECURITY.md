# Security model

GithubCopilotWebUI is a trusted-machine application without process or network isolation. Shell commands and private scripts run as the operating-system user that started the application. They can modify repositories, read other files available to that user, start processes, and access local, private, or public network destinations.

## Trust boundaries

- GitHub tokens are encrypted at rest with AES-256-GCM and are decrypted only by the API or Worker.
- Tokens, application secrets, and database credentials are not added to the environment passed to executed commands.
- Session identifiers are not authorization. Session routes check the authenticated owner in SQLite.
- Audit conversation reads (`/api/audit/sessions` and `/api/audit/sessions/:id`) require an authenticated user whose GitHub login is listed in `audit.admins`. An empty allowlist keeps those endpoints closed.
- The Copilot runtime uses `mode: "empty"`, receives a per-user GitHub token, and exposes only application-defined tools.
- SDK write/edit tools and unexpected `write` permission requests are rejected. Repository edits are available only through the custom `apply_patch` tool or an approved host command/private script.
- The Local Execution Runner and Worker control endpoint bind to loopback by default and require independent bearer tokens.

## Repository access

Repository read tools reject parent traversal, hidden build/dependency surfaces, and symlinks that escape the registered root. `apply_patch` validates unified diffs with `git apply --check` before applying them and relies on Git's default unsafe-path rejection. These restrictions do not apply to an approved shell command or private script: local processes receive the repository as their working directory and operate with the full permissions of the service account.

An enabled repository must therefore be considered entirely visible and writable by the Agent after execution is approved. Register only dedicated, reviewed repositories and do not include production credentials, private keys, or unrelated sensitive files.

## Execution approval

- **Interactive:** every shell, patch, diagnostics, test, URL, and private-script request waits for the Session owner.
- **Session scoped:** selected capability groups are automatically approved for one Session.
- **Allow all:** shell, patch, diagnostics, test, URL, and private-script requests run without additional prompts.

Approval requests expire after five minutes and are denied on stop, logout, deletion, or Worker shutdown. Approval only decides whether execution starts; it is not a security boundary around the resulting process. `Allow all` should be reserved for fully trusted users and repositories.

## Secure forms

`request_secure_form` and the sandbox helper `node "$COPILOT_SECURE_FORM_BIN"` collect passwords, one-time codes, and approve-on-device confirmations from the session owner.

- Field values are not written to `SessionEvent`, audit metadata, tool transcripts, or the model result. The model learns status, field names, and delivery success or failure.
- Values are held as short-lived buffers in the API process, claimed once, then zeroed. JavaScript strings created while reading the HTTP body cannot be wiped reliably.
- Submit and cancel routes require the session cookie, owner check, and CSRF token. Internal create, claim, and cancel routes require the worker or sandbox bearer token plus a matching `sessionId`.
- Allow-all does not submit or skip a secure form. A `deliveryCommand` still needs a separate shell approval before the form opens, including in allow-all and session-scoped modes. A helper started inside an already approved shell is covered by that shell approval.
- The turn clock pauses while a form is pending, and the worker keeps renewing the turn lease. Stop, logout, deletion, worker shutdown, and lease recovery cancel pending forms.
- Exact stdout/stderr redaction runs after a delivery command. It does not stop a command from encoding or writing the same secret somewhere else. An approved shell remains the host-user trust boundary described above.
- There is no browser automation. Values are not typed into a third-party login page. The real handoff is JSON on the receiving process stdin.

## Network behavior

The dedicated URL tool resolves and validates public HTTP/HTTPS targets, rejects loopback, private, link-local, carrier-grade NAT and metadata addresses, disables redirects, and caps response size.

Shell commands and private scripts use the host network directly. They can access destinations that the dedicated URL tool would reject and may transmit repository or host data elsewhere. Apply host firewall, proxy, account, and network policies outside GithubCopilotWebUI when restrictions are required.

## Operational guidance

- Run the application with a dedicated low-privilege operating-system account.
- Keep API, Local Execution Runner, and Worker control ports on loopback; expose only the Web endpoint through a trusted HTTPS reverse proxy when remote access is required.
- `TOKEN_ENCRYPTION_KEY` must be base64 for exactly 32 bytes. `COOKIE_SECRET`, `SANDBOX_RUNNER_TOKEN`, and `WORKER_CONTROL_TOKEN` must be unique values of at least 32 characters. Placeholder values from `.env.example` are rejected at startup.
- Rotate `COOKIE_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SANDBOX_RUNNER_TOKEN`, and `WORKER_CONTROL_TOKEN` using an established secret-management process.
- Protect and back up `data/copilot.db` together with `data/copilot/`; stop the services or use a SQLite-aware online backup so the WAL is not omitted.
- Review `AuditLog` records without copying OAuth tokens or sensitive command output into external logging systems.
- Revoke GitHub App authorization and remove Web Sessions when a user leaves the allowed organization.

## Reporting

Do not include credentials, repository contents, or command output in a vulnerability report. Use synthetic data and include the affected component, reproduction steps, and expected versus observed behavior.
