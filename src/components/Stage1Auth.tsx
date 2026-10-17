import { ShadRoxLogo } from './Logo';

interface Stage1AuthProps {
  onSignIn: () => void;
  isSigningIn?: boolean;
}

export function Stage1Auth({ onSignIn, isSigningIn = false }: Stage1AuthProps) {
  return (
    <div className="w-full h-full flex items-center justify-center bg-black px-6">
      <div className="w-full max-w-sm flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-2xl border border-neutral-800 bg-neutral-950 flex items-center justify-center mb-6 shadow-lg shadow-emerald-950/20">
          <ShadRoxLogo className="w-8 h-8 text-white" />
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-white">ShadRox</h1>
        <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
          Browser-native AI engineering workspace. Bring your own keys — Gemini, Groq, OpenAI — and edit code directly with live project preview.
        </p>

        <button
          type="button"
          onClick={onSignIn}
          disabled={isSigningIn}
          className="mt-8 w-full py-3 bg-white text-black text-xs font-semibold uppercase tracking-widest hover:bg-neutral-200 disabled:opacity-60 transition-colors cursor-pointer"
        >
          {isSigningIn ? 'Connecting...' : 'Continue to Workspace'}
        </button>

        <p className="mt-4 text-[11px] text-neutral-600 leading-relaxed">
          Local developer session active. Zero server uploads.
        </p>
      </div>
    </div>
  );
}
