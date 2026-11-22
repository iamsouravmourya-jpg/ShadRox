# Bring your own key (BYOK)

ShadRox is free and BYOK-only. There is no ShadRox plan, checkout, shared key, or meter: your own provider key carries every AI request and your provider bills you directly. Legacy paid-plan and shared-key values from older builds are deleted at startup, not interpreted.

## Supported providers

| Provider | What you need |
|---|---|
| Google Gemini | A Gemini API key |
| Groq | A Groq API key |
| Custom OpenAI-compatible endpoint | A base URL plus a key — works with compatible gateways and local servers such as Ollama and LM Studio |

- Add and validate keys in **Settings → Models & Keys**. Validation lists the models the provider reports; for an endpoint that does not list `/models`, you can type model ids manually.
- The custom endpoint's base URL is not a credential and is stored in plain settings; the key itself goes through the secret path below.
- Model availability, limits, and charges depend entirely on your provider. Labels like "free on your key" or "paid on your key" describe what **your provider** charges that key, not a ShadRox tier.
- Where the UI says "credits" (run budgets, automation caps), it means ShadRox's internal unit of work — roughly one edit-sized turn — never money. It exists only to stop a runaway run.

## Where keys are stored

- **Desktop app (installed build):** keys live in the OS-backed encrypted store (Electron `safeStorage`, e.g. DPAPI on Windows) plus session memory. They are never written to `localStorage`, and older plaintext mirrors are purged. The key is used by the local API process to call the provider you chose; it is not sent to ShadRox.
- **Browser dev build (`npm run dev`):** there is no OS-store bridge, so the key sits in that browser's `localStorage` in plain text and is posted to the local `/api/byok/validate` and `/api/ai` routes on your own machine. Do not run the browser build on a shared machine or with a key you would not accept seeing in that browser's profile.
- You can forget a key per provider in Settings. If OS encryption is unavailable, secret storage is refused rather than silently downgraded.

## What leaves your machine

| Data | Destination | Notes |
|---|---|---|
| Project files | Nowhere | Opened and edited on your disk; no ShadRox cloud project sync |
| AI prompt + selected context | Your configured provider only | Selected files, search results, a compact repo map, project rules, recent conversation (compacted locally when long) |
| Provider key | Your provider (from your machine) | Encrypted at rest on desktop; never sent to ShadRox |
| Account profile | Supabase (auth only) | Email, name, avatar, app version, platform. No project files or prompts |
| Feedback message | The owner's private Google Sheet | Only when you press Send feedback; see below |

Only the prompt and the context included with that request go to the provider. Do not send private code to a provider unless its data-handling terms are acceptable to you. API error text is redacted for GitHub- and AWS-shaped tokens before it is shown or stored, and terminal environments drop credential-shaped variables.

## Account

Google sign-in through Supabase is required to enter the desktop app; there is no password to create. **Continue with Google** stays disabled until you tick that you agree to the Terms of Service and Privacy Policy. Supabase stores the minimum profile fields listed above — nothing about your projects.

## Feedback

The top-bar Feedback button opens a drawer with exactly two report types: **Bug** and **Feature request**. The app POSTs a small JSON body (`{ kind, message }`) straight to a Google Apps Script web app owned by the maintainer, which appends one row to a private Google Sheet:

| Column | Contents |
|---|---|
| Date | Stamped server-side by Apps Script (`yyyy-MM-dd HH:mm:ss`, sheet time zone) |
| Bug | The message, when the report type is Bug |
| Feature | The message, when the report type is Feature request |

Nothing else is collected: no email or account row, no app version, no platform or user agent, no code, file names, or diagnostics. There is no ShadRox feedback server, no Supabase table, and no analytics in this path. The endpoint is write-only (opening it in a browser prints `Not found`), validates the payload, enforces a per-hour write quota, and caps message length.

<details>
<summary>Owner setup (one time, for maintainers)</summary>

The webhook endpoint is baked into the build; end users configure nothing.

1. Create a Google Sheet (the first tab is used).
2. Create the script: either standalone at `script.google.com` (paste `scripts/feedback-apps-script.gs`, set `SHEET_ID` from the sheet URL — most reliable when the browser is signed into multiple Google accounts), or bound via the sheet's Extensions → Apps Script (leave `SHEET_ID` empty).
3. Deploy → New deployment → Web app, **Execute as: Me**, **Who has access: Anyone**; copy the `/exec` URL.
4. Add `SHADROX_FEEDBACK_WEBHOOK=<your /exec URL>` to `.env` (gitignored) and rebuild with `npm run dist:win`.

The URL is encoded at build time and decoded in memory — a speed bump against casual copying, not a secret. The real limits are server-side: write-only access, strict payload validation, a per-hour quota, and a sheet only the owner can read. Keep the URL out of the repo, issues, and screenshots; if it leaks, redeploy the web app for a new `/exec` URL and rebuild.

</details>

## Related

- Agent safety and what the agent can read (including masked `.env` values): [agent-tools.md](./agent-tools.md)
- Privacy summary: [../PRIVACY.md](../PRIVACY.md) · Beta terms: [../BETA_TERMS.md](../BETA_TERMS.md)

## Keep reading

- [Features](./features.md) · [BYOK & keys](./byok.md) · [Agent tools](./agent-tools.md) · [Troubleshooting](./troubleshooting.md) · [FAQ](./faq.md)
- [README](../README.md) · [Website](https://www.shadrox.cyou) · [Releases](https://www.shadrox.cyou/releases) · [Contributors](https://www.shadrox.cyou/contributors)
