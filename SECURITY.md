# Security model

> `SANDBOX_BACKEND=local` is an explicitly unisolated development and trusted-machine mode. Shell commands and private scripts run as the operating-system user that started CopilotDeck and can read or modify any file that user can access. The container guarantees described below apply only when `SANDBOX_BACKEND=container`.

## Trust boundaries

- GitHub tokens are encrypted at rest with AES-256-GCM and are only decrypted by the API or Worker.
- GitHub tokens, database credentials, application secrets, and the container-runtime socket are never injected into Agent sandboxes.
- Session identifiers are not authorization. Every API operation checks the authenticated owner in the active SQLite or PostgreSQL database.
- The Copilot runtime runs in `mode: "empty"` and receives a per-session GitHub token.
- In container mode, only the Sandbox Runner can ask the rootless container daemon to execute a workload.

## Repository immutability

In container mode, repository paths are mounted read-only into every sandbox. The SDK has no write/edit tools and rejects every unexpected `write` permission request. Commands such as shell redirection, `sed -i`, package installation into the project, and `git commit` must fail against `/repo`. Temporary output belongs under `/tmp` and is destroyed with the sandbox.

In local mode, SDK write tools remain disabled, but shell commands and private scripts are not restricted by that policy. They run with the host repository as their working directory and may modify it or access unrelated host files. Use local mode only on a trusted, single-user machine with repositories that can safely be changed or disclosed.

This does not make repository contents confidential from the Agent. A script can read everything exposed by its repository mount. Register only dedicated, reviewed roots.

## Execution approval

- **Interactive:** every shell, URL, and private-script call waits for the owner.
- **Session scoped:** selected capability groups auto-approve for one conversation.
- **Allow all:** all three capability groups auto-approve in the configured execution backend.

In container mode, no approval mode can enable repository writes, host access, Docker access, privileged containers, or private-network destinations. In local mode, approval controls when execution starts but does not restrict what the resulting host process can access. Approval requests expire after five minutes and are denied on stop, logout, deletion, or Worker shutdown.

## Network policy

The Compose sandbox network is marked internal. Proxy-aware command-line tools reach the internet only through Squid, which rejects private, loopback, link-local, carrier-grade NAT, and metadata ranges. The dedicated URL tool also resolves and validates its target before fetching, disables redirects, and caps response size.

Local-mode shell commands and scripts use the host network directly and are not limited by the dedicated URL tool's filtering. They may access local services, private networks, and public endpoints available to the host user.

Applications that ignore `HTTP_PROXY`, create raw sockets, or implement unusual DNS behavior cannot reach the public internet from the internal Docker network. Keep the internal network isolated and do not attach application/database services to it.

## Operational guidance

- Use rootless Docker or Podman; never mount a privileged system daemon socket.
- Terminate TLS in front of both Web and API services before exposing the application beyond localhost.
- Rotate `COOKIE_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SANDBOX_RUNNER_TOKEN`, and `WORKER_CONTROL_TOKEN` through an established secret-management process.
- Keep the local Worker control endpoint bound to loopback. Do not proxy or expose port 4200.
- In local mode, protect and back up `data/copilot.db` together with `data/copilot/`; stop the API and Worker or use a SQLite-aware online backup so the WAL is not omitted.
- In multi-user mode, protect and back up PostgreSQL and the Copilot state volume together.
- Review Squid logs and `AuditLog` records; neither should contain OAuth tokens.
- Keep `ALLOW_ALL` exceptional and communicate that it permits data exfiltration to public URLs.
- Revoke the GitHub App authorization and remove application web sessions when a user leaves the allowed organization.

## Reporting

Do not include credentials, repository content, or command output in a vulnerability report. Include the affected component, reproduction steps using synthetic data, and expected versus observed isolation behavior.
