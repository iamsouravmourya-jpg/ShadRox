# FAQ

Plain answers about the ShadRox beta (v0.1.2). These mirror the questions on the website's FAQ page; where the beta has changed, the answer here reflects the current code.

## Can I download ShadRox now?

Yes. The latest beta installer (v0.1.2) is for Windows 10 or 11, 64-bit: [ShadRox-v0.1.2-Setup.exe](https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-v0.1.2-Setup.exe). The build is unsigned, so SmartScreen may warn — verify the download source before choosing **More info → Run anyway**. See [troubleshooting.md](./troubleshooting.md).

## Do I need an account?

Yes. Google sign-in through Supabase is required to enter the desktop app; there is no password to create. Account profile fields are email, name, avatar, app version, and platform — nothing about your projects. You must accept the Terms and Privacy Policy before the sign-in button enables.

## Does ShadRox store my project in the cloud?

No. Project files are opened and edited on your computer. There is no ShadRox cloud project sync.

## What is sent when I use AI?

Only the prompt and the project context included with that request (selected files, search results, a compact repo map, project rules, recent conversation) go to the AI provider configured for it. Providers process that data under their own data-handling terms. Your key travels from your machine to your provider, never to ShadRox. Details: [byok.md](./byok.md).

## Which AI providers are supported?

Google Gemini, Groq, and custom OpenAI-compatible endpoints, including compatible local gateways such as Ollama and LM Studio. Model availability and charges depend on your provider.

## Where is my AI key stored?

In the desktop app, keys live in OS-backed encrypted storage (Settings → Models & Keys) and are never written to plain local storage. In the browser dev build (`npm run dev`) there is no OS-store bridge, so the key sits in that browser's `localStorage` in plain text — do not use the browser build on a shared machine. See [byok.md](./byok.md#where-keys-are-stored).

## Can the agent make changes on its own?

Not silently, and not without tiers. Inspection tools are read-only. In Agent mode, shell commands are parsed and risk-classified: reads, builds/tests, and installs (including `npm test`, `pytest`, `tsc --noEmit`, `npm install`, Git status/diff) **run automatically** and stay visible in the terminal dock; file-modifying and network commands open a native approval dialog; dangerous commands (deletes outside the workspace, `sudo`, download-piped-to-shell, disk tooling) **always** ask, with a red warning, and can never be pre-approved. File edits go through a verified save pipeline with a rewrite guard; deleting a path needs an explicit confirm plus your click and a follow-up read that proves it is gone. Ask and Plan modes never mutate anything. Agent workflows are beta — inspect results and keep backups. Full model: [agent-tools.md](./agent-tools.md).

## How do updates work?

The app checks for a newer release about 15 seconds after start and every 6 hours after that, and shows a badge when one is ready. Nothing is downloaded or installed automatically — you download the installer from the release page and run it when you choose.

## Does ShadRox cost anything?

No. ShadRox is free and bring-your-own-key only. There is no plan to buy, no checkout, and no charge from ShadRox; your own provider key carries every request and your provider bills you directly. "Credits" in run budgets are an internal unit of work, never money.

## Can I preview any project?

ShadRox supports Markdown, static sites, detected Node web projects (Vite, Next.js, Nuxt, Astro, Angular, SvelteKit, Remix, webpack, Parcel, and other detected scripts), and detected Python, Go, PHP, Java, and .NET backends. The project's runtime must be installed on your machine, and not every configuration is supported. Some external sites block embedded previews. Port conflicts are handled by relocating, never by killing foreign processes — see [troubleshooting.md](./troubleshooting.md).

## Can I preview a README or Markdown file?

Yes. Select any `.md` or `.markdown` file and use the **Preview** button beside its name; switch back to **Source** to edit.

## Can I send a follow-up message while the AI is working?

Yes. Up to 5 follow-up messages are held in a queue and sent after the current turn finishes, rather than interrupting it. Each queued message keeps the workspace, key, and model you queued it with.

## Who is behind ShadRox?

ShadRox is a solo project built by Sourav Maurya, a 19-year-old full-stack developer and AI engineer based in Delhi, India. There is no company behind it — the app, the website ([shadrox.cyou](https://www.shadrox.cyou)), and the GitHub repo are all maintained by one person, in the open.

## Where does feedback go?

The Feedback button in the app sends only the message you type — tagged as Bug or Feature request — plus a server-side date, into the maker's private Google Sheet (columns: date, bug, feature). Nothing else is attached: no email, account details, app version, platform, code, file names, or diagnostics, and no ShadRox server sits in this path. Setup and limits: [byok.md](./byok.md#feedback).

## Keep reading

- [Features](./features.md) · [BYOK & keys](./byok.md) · [Agent tools](./agent-tools.md) · [Troubleshooting](./troubleshooting.md) · [FAQ](./faq.md)
- [README](../README.md) · [Website](https://www.shadrox.cyou) · [Releases](https://github.com/iamsouravmourya-jpg/ShadRox/releases) · [Contributors](https://www.shadrox.cyou/contributors)
