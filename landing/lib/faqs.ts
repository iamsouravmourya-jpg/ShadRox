import { APP_VERSION } from '@/lib/download'

// Single source of truth for the FAQ: rendered by components/landing/faq.tsx
// and serialized as FAQPage JSON-LD on app/faq/page.tsx. Keep text identical.
export const faqs = [
  {
    q: 'Can I download ShadRox now?',
    a: `Yes. The latest beta installer (v${APP_VERSION}) is for Windows 10 or 11, 64-bit. The Windows build is unsigned, so SmartScreen may show a warning — verify the download source before choosing More → Run anyway.`,
  },
  {
    q: 'Do I need an account?',
    a: 'Yes. Google sign-in through Supabase is required to enter the desktop app. Account profile fields include email, name, avatar, app version, and platform. There is no password to create.',
  },
  {
    q: 'Does ShadRox store my project in the cloud?',
    a: 'No. Project files are opened and edited on your computer. ShadRox does not sync project folders to a cloud workspace.',
  },
  {
    q: 'What is sent when I use AI?',
    a: 'Only the prompt and project context you choose are sent to the AI provider configured for that request. AI providers process that data under their own data-handling terms.',
  },
  {
    q: 'Which AI providers are supported?',
    a: 'Google Gemini, Groq, and custom OpenAI-compatible endpoints, including compatible local gateways such as Ollama and LM Studio. Model availability and charges depend on your provider.',
  },
  {
    q: 'Where is my AI key stored?',
    a: 'The desktop app stores provider keys in OS-backed encrypted storage. AI requests go from your machine to the configured provider; the key is not sent to ShadRox.',
  },
  {
    q: 'Can the agent make changes on its own?',
    a: 'Not silently. Inspection tools are read-only. The agent can run one shell command at a time in your opened folder and gets its real exit code back, but every command — including npm test, pytest, tsc --noEmit and Git status/diff — opens a native approval dialog with a plain-language risk notice first. File edits go through a guarded patch and review flow; unsafe changes are held for review. Deleting a path needs an explicit confirm plus a follow-up read that proves it is gone. Agent and autonomous workflows are beta, so inspect results and keep backups.',
  },
  {
    q: 'How do updates work?',
    a: 'The app checks for a newer release about 15 seconds after start and every 6 hours after that, and shows a badge when an update is ready. Nothing is downloaded or installed automatically — you download the installer from the release page and run it when you choose.',
  },
  {
    q: 'Does ShadRox cost anything?',
    a: 'No. ShadRox is free and runs on bring-your-own-key. There is no plan to buy, no checkout and no charge from ShadRox; your own provider key carries every request and your provider bills you directly.',
  },
  {
    q: 'Can I preview any project?',
    a: 'ShadRox supports Markdown, static sites, detected Node web projects, and detected Python, Go, PHP, Java, and .NET backends. The project runtime must be installed, and not every configuration is supported.',
  },
  {
    q: 'Can I preview a README or Markdown file?',
    a: 'Yes. Select any .md or .markdown file and use the Preview button beside its name. Switch back to Source to edit it.',
  },
  {
    q: 'Can I send a follow-up message while the AI is working?',
    a: 'Yes. Follow-up messages are held in a small queue and sent after the current turn finishes, rather than interrupting it.',
  },
  {
    q: 'Who is behind ShadRox?',
    a: 'ShadRox is a solo project built by Sourav Maurya, a 19-year-old full-stack developer and AI engineer based in Delhi, India. There is no company behind it — the app, the website, and the GitHub repo are all maintained by one person.',
  },
  {
    q: 'Does the Junk & Dead-Code Scanner upload my code anywhere?',
    a: 'No. Since v0.1.3 and throughout v0.1.4, the scanner walks your workspace locally in a non-blocking background pass, preserves serverless, edge, worker, Prisma, and Drizzle entry points, classifies High Confidence vs Needs Review files, and sends deleted items to the OS Trash / Recycle Bin.',
  },
  {
    q: 'Do I have to install a debugger separately?',
    a: 'No. ShadRox v0.1.4 bundles Microsoft\'s js-debug adapter directly inside the app and infers Node.js, TypeScript, Vite, and Next.js launch configs automatically when shadrox.debug.json is absent.',
  },
  {
    q: 'Where does feedback go?',
    a: 'The Feedback button in the app sends only the message you type — tagged as a bug or a feature — plus the date, into the maker\'s private Google Sheet in three columns: date, bug and feature. Nothing else is attached — no email, account details, app version, platform, code, file names or diagnostics — and no ShadRox server sits in this path.',
  },
]