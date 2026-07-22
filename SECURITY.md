# Security model

CopilotDeck is a trusted-machine application without process or network isolation. Shell commands and private scripts run as the operating-system user that started the application. They can modify repositories, read other files available to that user, start processes, and access local, private, or public network destinations.

## Trust boundaries

- GitHub tokens are encrypted at rest with AES-256-GCM and are decrypted only by the API or Worker.
- Tokens, application secrets, and database credentials are not added to the environment passed to executed commands.
- Session identifiers are not authorization. Every API operation checks the authenticated owner in SQLite.
- The Copilot runtime uses `mode: "empty"`, receives a per-user GitHub token, and exposes only application-defined tools.
- SDK write/edit tools and unexpected `write` permission requests are rejected.
- The Local Execution Runner and Worker control endpoint bind to loopback by default and require independent bearer tokens.

## Repository access

Repository read tools reject parent traversal, hidden build/dependency surfaces, and symlinks that escape the registered root. These restrictions do not apply to an approved shell command or private script: local processes receive the repository as their working directory and operate with the full permissions of the service account.

An enabled repository must therefore be considered entirely visible and writable by the Agent after execution is approved. Register only dedicated, reviewed repositories and do not include production credentials, private keys, or unrelated sensitive files.

## Execution approval

- **Interactive:** every shell, URL, and private-script request waits for the Session owner.
- **Session scoped:** selected capability groups are automatically approved for one Session.
- **Allow all:** shell, URL, and private-script requests run without additional prompts.

Approval requests expire after five minutes and are denied on stop, logout, deletion, or Worker shutdown. Approval only decides whether execution starts; it is not a security boundary around the resulting process. `Allow all` should be reserved for fully trusted users and repositories.

## Network behavior

The dedicated URL tool resolves and validates public HTTP/HTTPS targets, rejects loopback, private, link-local, carrier-grade NAT and metadata addresses, disables redirects, and caps response size.

Shell commands and private scripts use the host network directly. They can access destinations that the dedicated URL tool would reject and may transmit repository or host data elsewhere. Apply host firewall, proxy, account, and network policies outside CopilotDeck when restrictions are required.

## Operational guidance

- Run the application with a dedicated low-privilege operating-system account.
- Keep API, Local Execution Runner, and Worker control ports on loopback; expose only the Web endpoint through a trusted HTTPS reverse proxy when remote access is required.
- Rotate `COOKIE_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SANDBOX_RUNNER_TOKEN`, and `WORKER_CONTROL_TOKEN` using an established secret-management process.
- Protect and back up `data/copilot.db` together with `data/copilot/`; stop the services or use a SQLite-aware online backup so the WAL is not omitted.
- Review `AuditLog` records without copying OAuth tokens or sensitive command output into external logging systems.
- Revoke GitHub App authorization and remove Web Sessions when a user leaves the allowed organization.

## Reporting

Do not include credentials, repository contents, or command output in a vulnerability report. Use synthetic data and include the affected component, reproduction steps, and expected versus observed behavior.
