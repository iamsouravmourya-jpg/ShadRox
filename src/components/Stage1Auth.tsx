import { DevoraLogo } from './Logo';

interface Stage1AuthProps {
  onSignIn: () => void;
  isSigningIn?: boolean;
}

export function Stage1Auth({ onSignIn, isSigningIn = false }: Stage1AuthProps) {
  return (
    <div className="w-full h-full flex items-center justify-center bg-black px-6">
      <div className="w-full max-w-sm flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-2xl border border-neutral-800 bg-neutral-950 flex items-center justify-center mb-6">
          <DevoraLogo className="w-8 h-8 text-white" />
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-white">Devora</h1>
        <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
          Apna AI coding workspace. Apni API key laao — Groq ya Gemini — aur seedha browser se code likho.
        </p>

        <button
          type="button"
          onClick={onSignIn}
          disabled={isSigningIn}
          className="mt-8 w-full py-3 bg-white text-black text-xs font-semibold uppercase tracking-widest hover:bg-neutral-200 disabled:opacity-60 transition-colors cursor-pointer"
        >
          {isSigningIn ? 'Signing in...' : 'Continue'}
        </button>

        <p className="mt-4 text-[11px] text-neutral-600 leading-relaxed">
          Demo sign-in active hai. Google auth (Supabase) next phase me aayega.
        </p>
      </div>
    </div>
  );
}
