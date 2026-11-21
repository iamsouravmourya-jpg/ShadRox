import { useRef, useState } from 'react';
import { AlertCircle, Check, Loader2, ShieldCheck } from 'lucide-react';
import { ShadRoxLogo } from './Logo';

interface AuthScreenProps {
  status: 'loading' | 'unconfigured' | 'signed-out' | 'signed-in';
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="w-4 h-4 shrink-0">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.4a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.6-5.2 3.6-8.8Z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
    </svg>
  );
}

export function AuthScreen({ status, busy, error, onSignIn }: AuthScreenProps) {
  const [accepted, setAccepted] = useState(false);
  const [termsHint, setTermsHint] = useState(false);
  const termsRef = useRef<HTMLInputElement>(null);

  const handleSignIn = () => {
    if (busy) return;
    // A disabled button swallows the click, so a user who missed the checkbox
    // sees nothing happen. Explain the gate and put the focus on it instead.
    if (!accepted) {
      setTermsHint(true);
      termsRef.current?.focus();
      return;
    }
    onSignIn();
  };

  if (status === 'loading') {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center gap-4 bg-base text-ink">
        <ShadRoxLogo className="w-8 h-8 text-accent" />
        <span className="flex items-center gap-2 text-xs text-ink-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Checking your session…
        </span>
      </div>
    );
  }

  const unconfigured = status === 'unconfigured';

  return (
    <div className="w-full h-screen bg-base text-ink flex flex-col titlebar">
      <div className="h-12 shrink-0 flex items-center justify-between border-b border-line px-5">
        <span className="flex items-center gap-2">
          <ShadRoxLogo className="w-4 h-4 text-accent" />
          <span className="text-xs font-semibold tracking-[-0.02em]">ShadRox</span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3 tabular-nums">
          Desktop beta · v0.1.3 · Windows
        </span>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center px-6 pb-12">
        <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-[var(--shadow-panel)]">
          <div className="mb-7 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-accent-line bg-accent-soft">
              <ShadRoxLogo className="w-6 h-6 text-accent" />
            </div>
            <h1 className="text-2xl font-semibold tracking-[-0.03em] text-ink">Sign in to ShadRox</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">
              One Google account for the beta. Your projects and API keys stay on this device; AI requests go from here straight to
              the provider you choose.
            </p>
          </div>

          {unconfigured ? (
            <div className="rounded-xl border border-warn/30 bg-warn/10 p-4 text-sm text-warn/90">
              <p className="font-medium text-warn">Sign-in is not configured in this build.</p>
              <p className="mt-2 text-xs leading-relaxed text-warn/70">
                This installer was built without Supabase credentials. Set <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
                <code className="font-mono">VITE_SUPABASE_ANON_KEY</code>, then rebuild the desktop app.
              </p>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={handleSignIn}
                aria-disabled={busy || !accepted}
                className={`flex w-full items-center justify-center gap-3 rounded-xl bg-[var(--text)] px-4 py-3 text-sm font-semibold text-[var(--bg)] shadow-[0_1px_2px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.08)] transition-[opacity,transform] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                  busy
                    ? 'cursor-wait opacity-70'
                    : accepted
                      ? 'cursor-pointer hover:opacity-90 active:scale-[0.99]'
                      : 'cursor-not-allowed opacity-60'
                }`}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GoogleMark />}
                {busy ? 'Waiting for your browser…' : 'Continue with Google'}
              </button>

              {termsHint && !accepted && (
                <p role="status" className="mt-2 text-center text-[11px] text-warn">
                  Tick the box below to continue.
                </p>
              )}

              <label
                htmlFor="auth-terms"
                className="mt-3 flex w-full cursor-pointer select-none items-start gap-2.5 rounded-lg px-0.5 py-1"
              >
                <span className="pointer-events-none mt-px flex h-4 w-4 shrink-0 items-center justify-center">
                  <input
                    id="auth-terms"
                    ref={termsRef}
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => {
                      setAccepted(event.target.checked);
                      if (event.target.checked) setTermsHint(false);
                    }}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={`flex h-4 w-4 items-center justify-center rounded-[5px] border border-line-2 bg-base-2 transition-[colors,box-shadow] peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40 ${
                      termsHint && !accepted ? 'ring-2 ring-warn/40' : ''
                    }`}
                  >
                    <Check
                      className={`h-3 w-3 text-white transition-colors ${accepted ? 'opacity-100' : 'opacity-0'}`}
                      strokeWidth={3}
                    />
                  </span>
                </span>
                <span className="text-[11px] leading-relaxed text-ink-3">
                  I agree to the{' '}
                  <a
                    href="https://shadrox.cyou/beta-terms"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    className="underline decoration-dotted underline-offset-2 text-ink-3 transition-colors hover:text-ink"
                  >
                    Terms of Service
                  </a>{' '}
                  and{' '}
                  <a
                    href="https://shadrox.cyou/privacy"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    className="underline decoration-dotted underline-offset-2 text-ink-3 transition-colors hover:text-ink"
                  >
                    Privacy Policy
                  </a>
                  .
                </span>
              </label>
            </>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs text-danger">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {busy && !error && (
            <p className="mt-4 text-center text-xs text-ink-4">
              Google sign-in opened in your browser. Finish there and this window will continue on its own.
            </p>
          )}

          <div className="mt-7 flex items-start gap-2.5 rounded-xl border border-line bg-overlay px-3.5 py-3 text-[11px] leading-relaxed text-ink-3">
            <ShieldCheck className="mt-0.5 w-4 h-4 shrink-0 text-ok" />
            <span>
              Sign-in creates only your account row (email and name). ShadRox&apos;s servers never receive your code, your project
              files, or your BYOK key (Gemini, Groq, or your own endpoint) — but the prompt and the project context you send do go
              to the AI provider you pick, under that provider&apos;s own terms.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
