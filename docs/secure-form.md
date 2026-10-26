# Secure forms

A secure form is how a running turn asks the signed-in user for a credential or an MFA step without putting the secret in the model context.

The chat card is the real UI. Submitted values are delivered as JSON on a process stdin. `@app/ms-login` is a Playwright script that uses that channel to sign in to Microsoft or SharePoint. It is the only browser login driver in this repository.

## What is real

- The agent tool `request_secure_form` opens a form for the active turn.
- An approved shell can run `node "$COPILOT_SECURE_FORM_BIN"` with the same schema. The sandbox sets `COPILOT_SECURE_FORM_SOCKET` and `COPILOT_SECURE_FORM_BIN`. When `MS_LOGIN_CLI` or `PLAYWRIGHT_BROWSERS_PATH` is set on the sandbox process, those names are added too. Service tokens are not added to the command environment.
- The web chat renders one card per revealed step: title, “Opens a secure form” with Open, then “Secure form” with Submitted. Open shows a modal. Password and OTP inputs are masked. Escape closes the modal without cancelling. Cancel cancels the form.
- Metadata and status (`pending`, `submitted`, `cancelled`, `expired`) are stored and replayed like approval cards. Submitted values are not.
- The API keeps values in memory, single-use, until claim, discard, expiry, or process restart. Restart expires pending forms.
- Delivery writes JSON to the command stdin. `final` is one document after every step. `each-step` from inside the shell writes a JSON line as each step is submitted. `each-step` from the agent tool is batched: the worker waits until the form is fully submitted, then the sandbox writes one JSON line per step.
- The turn deadline pauses while a form is pending, including a form opened from a background shell. The worker keeps renewing the lease. Stop cancels the form.
- A delivery command requires its own shell approval before the form is created, when that command is the agent tool's `deliveryCommand`. That approval is still required when the session is allow-all or session-scoped. Allow-all does not skip the form or auto-submit it. A helper started from an already approved shell is covered by that shell approval.

## MFA

Use an `otp` field when the user must type a code. The field is masked, trimmed, and delivered with the other values for that step.

Use a `confirm` step with no fields when the user must approve a prompt on their phone:

```json
{ "id": "approve", "kind": "confirm", "prompt": "Approve on your phone, then continue" }
```

The user clicks Continue. The delivered step is `{ "id": "approve", "kind": "confirm", "confirmed": true }` and has no secret. The model is told the form was submitted, not what the user typed.

Example shell request for a program you supply:

```sh
node "$COPILOT_SECURE_FORM_BIN" \
  --title "Sign in to Microsoft" \
  --target "login.microsoftonline.com" \
  --purpose "Open SharePoint" \
  --field "email:email:Work email" \
  --exec "python fill_login.py"
```

`fill_login.py` reads one JSON document on stdin. With `--each-step`, it reads one JSON object per line as the user advances. The helper stdout is only status. It never contains the values.

## Microsoft sign-in

`packages/ms-login` drives Chromium through Playwright. It opens a target URL, follows the Microsoft login page, and requests one secure form per discovered step. Only one form can be pending on a turn, and the MFA variant is not known until the page is visible, so the script does not open email, password, and MFA as one form.

Handled steps:

- Email (`#i0116` or `input[name=loginfmt]`), then Next.
- Password (`#i0118` or `input[name=passwd]`), then Sign in.
- A verification code (`#idTxtBx_SAOTCC_OTC` or `input[name=otc]`).
- Authenticator number matching. The script reads the number from `#idRichContext_DisplaySign` and puts it in the confirm prompt: `Approve sign-in request 42 in Microsoft Authenticator, then continue.` Continue means the user already approved on the phone. The script then polls until that screen goes away or the timeout is reached.
- “Stay signed in?”. The default is Yes (`#idSIButton9`) so the cookie can be reused. `--stay-signed-in false` clicks No (`#idBtn_Back`).

Reported outcomes use a fixed message catalog. The script does not return page text, the email address, the password, the code, or the matching number. Wrong password, unknown account, locked account, and a rejected code are separate results. A security-key, passkey, proof-picker, or captcha screen is `unsupported`.

Build and install the browser once on the host. The package install does not download Chromium:

```sh
pnpm --filter @app/ms-login build
pnpm --filter @app/ms-login exec playwright install chromium
```

Set `PLAYWRIGHT_BROWSERS_PATH` to that cache (often `$HOME/.cache/ms-playwright`). Approved shells use a temporary `HOME`, so Playwright will not see the default cache unless this variable is set on the sandbox. `scripts/dev.mjs` and `scripts/start-local.mjs` turn a `./` value into an absolute path.

Run it inside an approved shell. The sandbox provides `COPILOT_SECURE_FORM_BIN` and, when configured, `MS_LOGIN_CLI`:

```sh
node "$MS_LOGIN_CLI" \
  --url "https://contoso.sharepoint.com/sites/guild" \
  --storage "/secure/path/ms-login-state.json" \
  --headless true
```

The target URL is the site you want after sign-in. Its host is what the script treats as success, and it is the host shown on each form. `https://login.microsoftonline.com` is where the password is typed; it is not a successful landing host.

Arguments and environment:

| Argument | Environment | Default |
| --- | --- | --- |
| `--url` | `MS_LOGIN_URL` | required |
| `--storage` | `MS_LOGIN_STORAGE` | required |
| `--headless` | `MS_LOGIN_HEADLESS` | `true` |
| `--timeout-ms` | `MS_LOGIN_TIMEOUT_MS` | `180000` |
| `--poll-ms` | `MS_LOGIN_POLL_MS` | `2000` |
| `--stay-signed-in` | `MS_LOGIN_STAY_SIGNED_IN` | `true` |
| `--chromium-no-sandbox` | `MS_LOGIN_CHROMIUM_NO_SANDBOX=1` | off |

Stdout is one JSON object: `ok`, `code`, `message`, and `storageStatePath` after success. The process exits `0` only when `code` is `signed-in`.

### How the secret moves

The secure-form CLI prints status only. The sandbox writes the values to the stdin of the `--exec` process, which the sandbox starts. The login script listens on a mode `0600` socket in a temp directory and passes `--exec` a small bridge. The bridge copies stdin to that socket and prints nothing. The script types the value into the page and drops its reference. A secret printed on the helper stdout is ignored.

Each form is one field, or a confirm step with no fields. Field names are `email`, `password`, and `code`. The confirm id is `approve`.

### Approval

Starting `node "$MS_LOGIN_CLI"` is an approved shell (or an allow-all shell). Each step then opens a secure form the user must submit. Allow-all does not auto-submit those forms. The bridge process is spawned by the sandbox as part of delivering the form. It is not a second approval card. The shell that started the login script was already approved.

The script's own timeout counts wall time, including time the user spends on a form. The sandbox command deadline pauses only while a form is open. Navigation and the number-match poll after Continue count toward `COMMAND_TIMEOUT_SECONDS` (default 120). Raise that above the parts of the script that run while no form is pending, or lower `--timeout-ms`.

### Session reuse and expiry

On success the script writes Playwright storage state to `--storage`. The parent directory is created with mode `0700` when it did not already exist. The file is written via a temp file and ends as mode `0600`. It holds cookies such as `ESTSAUTH` and `ESTSAUTHPERSISTENT`. A later command can reuse them by launching Chromium with that `storageState` path, or by running this script again with the same `--storage` path (an existing file is loaded into the new context).

Microsoft decides how long those cookies last. A persistent cookie from “Stay signed in” often lasts days; a session cookie can end when the browser session ends, or sooner if the tenant sets a shorter sign-in frequency. Conditional access can ignore the file entirely. Delete the file to drop the saved session. Do not commit it.

The script does not log, print, screenshot, trace, or record a HAR or video. `DEBUG` and `PWDEBUG` are cleared in the login process so Playwright does not record actions. Fill errors are replaced with a fixed message so a thrown error cannot echo the value.

## What is still limited

- Conditional access, FIDO keys, passkeys, security keys, captcha, and a proof picker that does not show the standard code box or number-match markup are unsupported. The script returns `unsupported` when it sees those screens, or `timeout` when the markup does not match a known step.
- This repository has not been verified against a live `login.microsoftonline.com` tenant. Microsoft changes the login markup. The selectors above are the ones the script and the local fixture use.
- Exact text redaction of command output. A command that encodes the secret can still reveal it, and an approved shell can already read the host.
- The in-memory vault zeros `Buffer`s. The HTTP stack and the Playwright `fill` string still handle the value as a JavaScript string, which cannot be wiped reliably.
- The agent runtime’s own timeout is raised by eight secure-form waits and eight approval waits. The turn clock keeps pausing after that, but the runtime may stop.
- A container that cannot start Chromium's sandbox needs `MS_LOGIN_CHROMIUM_NO_SANDBOX=1`. If the browser executable is missing, the script reports that Playwright Chromium is not installed and does not echo the launch error.

## Delivery JSON

Final stdin document:

```json
{
  "formId": "...",
  "targetSite": "login.microsoftonline.com",
  "purpose": "Open SharePoint",
  "steps": [
    { "id": "email", "kind": "input", "values": { "email": "..." } },
    { "id": "password", "kind": "input", "values": { "password": "..." } },
    { "id": "approve", "kind": "confirm", "confirmed": true }
  ]
}
```

The helper’s own stdout is only status: `status`, `formId`, `delivered`, `fieldNames`, `exitCode`, `stdout`, `stderr`, `timedOut`, and `reason`.
