# Secure forms

A secure form is how a running turn asks the signed-in user for a credential or an MFA step without putting the secret in the model context.

This repository does not drive a browser. Nothing here types into `login.microsoftonline.com`, Apple, or SharePoint. The screenshot-style card is the real chat UI. The handoff to a login is a command that reads JSON from stdin.

## What is real

- The agent tool `request_secure_form` opens a form for the active turn.
- An approved shell can run `node "$COPILOT_SECURE_FORM_BIN"` with the same schema. The sandbox sets `COPILOT_SECURE_FORM_SOCKET` and `COPILOT_SECURE_FORM_BIN` only. Service tokens are not added to the command environment.
- The web chat renders one card per revealed step: title, “Opens a secure form” with Open, then “Secure form” with Submitted. Open shows a modal. Password and OTP inputs are masked. Escape closes the modal without cancelling. Cancel cancels the form.
- Metadata and status (`pending`, `submitted`, `cancelled`, `expired`) are stored and replayed like approval cards. Submitted values are not.
- The API keeps values in memory, single-use, until claim, discard, expiry, or process restart. Restart expires pending forms.
- Delivery writes JSON to the command stdin. `final` is one document after every step. `each-step` from inside the shell writes a JSON line as each step is submitted. `each-step` from the agent tool is batched: the worker waits until the form is fully submitted, then the sandbox writes one JSON line per step.
- The turn deadline pauses while a form is pending, including a form opened from a background shell. The worker keeps renewing the lease. Stop cancels the form.
- A delivery command requires its own shell approval before the form is created. That approval is still required when the session is allow-all or session-scoped. Allow-all does not skip the form or auto-submit it. A helper started from an already approved shell is covered by that shell approval.

## MFA

Use an `otp` field when the user must type a code. The field is masked, trimmed, and delivered with the other values for that step.

Use a `confirm` step with no fields when the user must approve a prompt on their phone:

```json
{ "id": "approve", "kind": "confirm", "prompt": "Approve on your phone, then continue" }
```

The user clicks Continue. The delivered step is `{ "id": "approve", "kind": "confirm", "confirmed": true }` and has no secret. The model is told the form was submitted, not what the user typed.

Example shell request:

```sh
node "$COPILOT_SECURE_FORM_BIN" \
  --title "Sign in to Microsoft (SharePoint Guild)" \
  --target "login.microsoftonline.com" \
  --purpose "Open SharePoint" \
  --field "email:email:Work email" \
  --field "password:password:Password" \
  --field "code:otp:Verification code" \
  --confirm "approve:Approve on your phone, then continue" \
  --exec "python fill_login.py"
```

`fill_login.py` reads one JSON document on stdin. With `--each-step`, it reads one JSON object per line as the user advances. A future browser script would be that command. It is not included.

## What is scaffolding

- No Playwright, Puppeteer, or other browser login driver.
- No automatic injection into a vendor page.
- Exact text redaction of command output. A command that encodes the secret can still reveal it, and an approved shell can already read the host.
- The in-memory vault zeros `Buffer`s. The HTTP stack still handles the JSON as JavaScript strings.
- The agent runtime’s own timeout is raised by eight secure-form waits and eight approval waits. The turn clock keeps pausing after that, but the runtime may stop.

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
