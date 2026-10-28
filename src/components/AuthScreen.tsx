import { AlertCircle, Loader2, ShieldCheck } from 'lucide-react';
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
  if (status === 'loading') {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center gap-4 bg-ink-950 text-white">
        <ShadRoxLogo className="w-8 h-8 text-violet-300" />
        <span className="flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Checking your session…
        </span>
      </div>
    );
  }

  const unconfigured = status === 'unconfigured';

  return (
    <div className="w-full h-screen bg-ink-950 text-white flex flex-col titlebar">
      <div className="h-12 shrink-0 flex items-center justify-between px-4">
        <span className="flex items-center gap-2">
          <ShadRoxLogo className="w-4 h-4 text-violet-300" />
          <span className="text-xs font-semibold tracking-[-0.02em]">ShadRox</span>
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Desktop beta · Windows</span>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center px-6 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-400/20 bg-violet-500/10">
              <ShadRoxLogo className="w-6 h-6 text-violet-300" />
            </div>
            <h1 className="text-2xl font-semibold tracking-[-0.03em]">Sign in to ShadRox</h1>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              One Google account for the beta. Your projects and API keys stay on this device.
            </p>
          </div>

          {unconfigured ? (
            <div className="rounded-xl border border-amber-300/20 bg-amber-400/[0.06] p-4 text-sm text-amber-200/90">
              <p className="font-medium text-amber-200">Sign-in is not configured in this build.</p>
              <p className="mt-2 text-xs leading-relaxed text-amber-200/70">
                This installer was built without Supabase credentials. Set <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
                <code className="font-mono">VITE_SUPABASE_ANON_KEY</code>, then rebuild the desktop app.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              disabled={busy}
              className="flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-70 cursor-pointer"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GoogleMark />}
              {busy ? 'Waiting for your browser…' : 'Continue with Google'}
            </button>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-500/[0.06] px-3 py-2.5 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {busy && !error && (
            <p className="mt-4 text-center text-xs text-zinc-500">
              Google sign-in opened in your browser. Finish there and this window will continue on its own.
            </p>
          )}

          <div className="mt-8 flex items-start gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-[11px] leading-relaxed text-zinc-500">
            <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400/70" />
            <span>
              Sign-in creates only your account row (email and name). ShadRox never receives your code, your project files, or your
              Gemini/Groq key.
            </span>
          </div>
        </div>
      </div>

      <p className="pb-6 text-center text-[10px] text-zinc-600">By continuing you agree to the beta terms · shadrox.cyou</p>
    </div>
  );
}
