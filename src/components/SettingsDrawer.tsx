import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle,
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  Key,
  Layers,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap
} from 'lucide-react';
import { PROVIDERS, getProviderMeta, type ModelInfo, type ModelTier, type ProviderId } from '../lib/providers';
import { PLANS, PLANS_LOCKED, getPlanMeta } from '../lib/plans';
import { SHARED_KEY_ENABLED } from '../lib/sharedKeyPolicy';
import { UpdateCard } from './UpdateCard';
import { getMonthlyUsage, resetMonthlyUsage, onQuotaChange, type UsageState } from '../lib/quota';
import type {
  GitHubRepo,
  GitHubUser,
  KeyStatus,
  PlanTier,
  SecretItem,
  SettingsTab,
  WorkspaceFile
} from '../lib/types';

interface SettingsDrawerProps {
  isOpen: boolean;
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;

  activeProvider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  apiKeyDraft: Record<ProviderId, string>;
  onApiKeyDraftChange: (provider: ProviderId, value: string) => void;
  keyStatus: Record<ProviderId, KeyStatus>;
  onValidateKey: (provider: ProviderId) => void;
  onForgetKey: (provider: ProviderId) => void;

  models: ModelInfo[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;

  temperature: number;
  onTemperatureChange: (value: number) => void;
  useShadRoxKey: boolean;
  onUseShadRoxKeyChange: (value: boolean) => void;

  plan: PlanTier;
  onPlanChange: (plan: PlanTier) => void;

  secrets: SecretItem[];
  onSecretsChange: (secrets: SecretItem[]) => void;

  workspaceFiles: WorkspaceFile[];
  onGenerateCommitMessage: () => Promise<string>;
  isWritingCommitMessage: boolean;

  accountEmail?: string | null;
  accountAvatarUrl?: string | null;
  onSignOut?: () => void;
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'CHAT', label: 'Models & Keys' },
  { id: 'PLAN', label: 'Subscription Plan' },
  { id: 'GITHUB', label: 'GitHub Sync' },
  { id: 'SECRETS', label: 'Secrets Vault' }
];

const TIER_BADGE: Record<ModelTier, string> = {
  free: 'text-violet-300 border-violet-300/25',
  pro: 'text-amber-400 border-amber-900/60'
};

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Request failed (HTTP ${response.status})`);
  return data;
}

export function SettingsDrawer(props: SettingsDrawerProps) {
  const {
    isOpen,
    activeTab,
    onTabChange,
    onClose,
    activeProvider,
    onProviderChange,
    apiKeyDraft,
    onApiKeyDraftChange,
    keyStatus,
    onValidateKey,
    onForgetKey,
    models,
    selectedModel,
    onSelectModel,
    temperature,
    onTemperatureChange,
    useShadRoxKey,
    onUseShadRoxKeyChange,
    plan,
    onPlanChange,
    secrets,
    onSecretsChange,
    workspaceFiles,
    onGenerateCommitMessage,
    isWritingCommitMessage,
    accountEmail,
    accountAvatarUrl,
    onSignOut
  } = props;

  const [githubToken, setGithubToken] = useState('');
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [targetRepo, setTargetRepo] = useState('');
  const [commitMessage, setCommitMessage] = useState('Update from ShadRox IDE');
  const [isCheckingGithub, setIsCheckingGithub] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [githubMessage, setGithubMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const [newSecretKey, setNewSecretKey] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');

  const [usage, setUsage] = useState<UsageState>(() => getMonthlyUsage(plan));

  useEffect(() => {
    setUsage(getMonthlyUsage(plan));
    return onQuotaChange(() => {
      setUsage(getMonthlyUsage(plan));
    });
  }, [plan]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const currentMeta = getProviderMeta(activeProvider);
  const currentDraft = apiKeyDraft[activeProvider] ?? '';
  const currentStatus = keyStatus[activeProvider];
  const currentSavedKey = currentStatus && currentStatus.state === 'ok';
  const hasStoredKey = currentDraft.trim().length > 0 || currentSavedKey;
  const currentPlan = getPlanMeta(plan);

  const handleGithubConnect = async () => {
    if (!githubToken.trim()) return;
    setIsCheckingGithub(true);
    setGithubMessage(null);
    try {
      const data = await postJson('/api/github/validate', { token: githubToken });
      setGithubUser(data.user);
      setGithubRepos(data.repos || []);
      setGithubMessage({ type: 'ok', text: `Connected as @${data.user.login}` });
    } catch (error) {
      setGithubMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'GitHub authentication failed.'
      });
    } finally {
      setIsCheckingGithub(false);
    }
  };

  const handleWriteCommitMessage = async () => {
    const message = await onGenerateCommitMessage();
    if (message) setCommitMessage(message);
  };

  const handleGithubPush = async () => {
    if (!targetRepo || workspaceFiles.length === 0) return;
    const [owner, repoName] = targetRepo.split('/');
    if (!owner || !repoName) {
      setGithubMessage({ type: 'error', text: 'Select a repository first.' });
      return;
    }
    setIsPushing(true);
    setGithubMessage(null);
    try {
      const data = await postJson('/api/github/push', {
        token: githubToken,
        owner,
        repo: repoName,
        commitMessage: commitMessage || 'Update from ShadRox IDE',
        files: workspaceFiles.map((file) => ({ name: file.name, content: file.content }))
      });
      const failed: Array<{ file: string; error?: string | null }> = (data.results ?? [])
        .filter((result: { status?: string }) => result.status !== 'success');
      if (failed.length > 0) {
        setGithubMessage({
          type: 'error',
          text: `${workspaceFiles.length - failed.length} file(s) pushed, ${failed.length} failed: ${failed
            .slice(0, 3)
            .map((entry) => `${entry.file}${entry.error ? ` (${entry.error})` : ''}`)
            .join(', ')}`
        });
        return;
      }
      setGithubMessage({
        type: 'ok',
        text: `Committed ${workspaceFiles.length} file(s) to ${targetRepo}.`
      });
    } catch (error) {
      setGithubMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to push files to repository.'
      });
    } finally {
      setIsPushing(false);
    }
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 top-12 z-50 flex justify-end bg-black/60 backdrop-blur-md"
      onClick={onClose}
    >
      <aside
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col border-l border-white/[0.08] bg-ink-950 text-white shadow-[-24px_0_60px_rgb(0_0_0/.45)]"
      >
        {/* Header */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.07] px-4">
          <div className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-300 shadow-[0_0_8px_#c4b5fd]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-200">
              ShadRox Settings
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close settings (Esc)"
            aria-label="Close settings"
            className="flex items-center gap-1 rounded-md p-1 text-neutral-500 hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Tabs */}
        <nav className="shrink-0 flex border-b border-white/[0.07]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`flex-1 border-b-2 py-2.5 text-center text-xs transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'border-violet-300 font-medium text-white'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6">
          {accountEmail && (
            <section className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              {accountAvatarUrl ? (
                <img src={accountAvatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-500/15 text-xs font-semibold text-violet-300">
                  {accountEmail.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider text-neutral-500">Signed in</p>
                <p className="truncate text-xs text-neutral-200">{accountEmail}</p>
              </div>
              {onSignOut && (
                <button
                  type="button"
                  onClick={onSignOut}
                  className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:border-red-400/30 hover:text-red-300 cursor-pointer"
                >
                  Sign out
                </button>
              )}
            </section>
          )}
          {activeTab === 'CHAT' && (
            <>
              {/* Provider Selection */}
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">AI Provider</h3>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {PROVIDERS.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => onProviderChange(provider.id)}
                      className={`rounded-xl border px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                        provider.id === activeProvider
                          ? 'border-violet-300/40 bg-violet-500/[.08] text-violet-100'
                          : 'border-white/[0.09] text-neutral-400 hover:border-white/[0.15] hover:text-neutral-200'
                      }`}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              </section>

              {/* API Key Input */}
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">
                  {currentMeta.label} API Key (BYOK)
                </h3>
                <p className="mt-1 text-[11px] text-neutral-400">
                  {currentMeta.keyHint}. Keys are encrypted on this device (Windows DPAPI) and only sent to {currentMeta.label}.
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={currentDraft}
                    onChange={(event) => onApiKeyDraftChange(activeProvider, event.target.value)}
                    placeholder={currentMeta.keyPlaceholder}
                    autoComplete="off"
                    className="flex-1 min-w-0 rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs font-mono text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-violet-300/40"
                  />
                  <button
                    type="button"
                    onClick={() => onValidateKey(activeProvider)}
                    disabled={currentStatus?.state === 'checking'}
                    className="whitespace-nowrap rounded-xl border border-violet-300/25 bg-violet-500/[.08] px-3 py-2 text-xs text-violet-100 transition-colors hover:bg-violet-500/[.14] disabled:opacity-40 cursor-pointer"
                  >
                    {currentStatus?.state === 'checking' ? 'Testing...' : 'Save & Test'}
                  </button>
                </div>

                {currentStatus && currentStatus.state !== 'idle' && (
                  <div
                    role="status"
                    className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                      currentStatus.state === 'ok'
                        ? 'border-violet-300/25 bg-violet-500/[.07] text-violet-300'
                        : currentStatus.state === 'error'
                          ? 'border-red-900/60 bg-red-950/20 text-red-400'
                          : 'border-white/[0.09] text-neutral-400'
                    }`}
                  >
                    {currentStatus.state === 'ok' ? (
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    ) : currentStatus.state === 'error' ? (
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    ) : (
                      <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin" />
                    )}
                    <span>
                      {currentStatus.state === 'ok'
                        ? `${currentMeta.label} key verified — ${currentStatus.modelCount} model(s) available (${currentStatus.latencyMs}ms).`
                        : currentStatus.state === 'error'
                          ? `Verification error: ${currentStatus.message}`
                          : 'Validating key connectivity...'}
                    </span>
                  </div>
                )}

                <div className="mt-2 flex items-center justify-between gap-3">
                  <a
                    href={currentMeta.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-white"
                  >
                    Get API key <ExternalLink className="w-3 h-3" />
                  </a>
                  {hasStoredKey && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`Remove the saved ${currentMeta.label} key from this device?`)) return;
                        onForgetKey(activeProvider);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-white/[0.09] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-red-500/40 hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove saved key
                    </button>
                  )}
                </div>
              </section>

              {/* Shared Key Option */}
              <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
                <label className={`flex items-start gap-2 ${SHARED_KEY_ENABLED ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                  <input
                    type="checkbox"
                    checked={useShadRoxKey}
                    onChange={(event) => onUseShadRoxKeyChange(event.target.checked)}
                    disabled={!SHARED_KEY_ENABLED}
                    className="mt-0.5 accent-violet-400"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-neutral-200 font-medium">Use ShadRox Shared Key</span>
                      {SHARED_KEY_ENABLED ? (
                        <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/[.08] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                          Pro
                        </span>
                      ) : (
                        <span className="shrink-0 flex items-center gap-1 rounded border border-white/10 bg-white/[.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                          <Lock className="w-2.5 h-2.5" />
                          Locked in beta
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-neutral-400 mt-1">
                      {SHARED_KEY_ENABLED
                        ? 'Run directly without bringing your own API key. Requests flow through our secure proxy for Pro-tier models.'
                        : 'Beta me sirf apni key chalti hai (BYOK). Apni Gemini ya Groq key upar add karo — ShadRox ka shared key launch ke waqt chalu hoga.'}
                    </span>
                  </span>
                </label>
                {plan === 'free' && (
                  <button
                    type="button"
                    onClick={() => onPlanChange('pro')}
                    disabled={PLANS_LOCKED}
                    className={`mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border py-2 text-[11px] font-medium transition-colors ${
                      PLANS_LOCKED
                        ? 'cursor-not-allowed border-white/10 bg-white/[.02] text-neutral-500'
                        : 'cursor-pointer border-amber-500/30 text-amber-300 hover:bg-amber-500/[.08]'
                    }`}
                  >
                    {PLANS_LOCKED ? <Lock className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
                    {PLANS_LOCKED ? 'Pro is locked during beta' : 'Upgrade to Pro (₹499/mo GST Included)'}
                  </button>
                )}
              </section>

              <UpdateCard />

              {/* Available Models */}
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Available Models {models.length > 0 && `(${models.length})`}
                </h3>
                {models.length === 0 ? (
                  <p className="mt-2 text-[11px] text-neutral-500">
                    No models loaded. Validate your API key above to fetch compatible models.
                  </p>
                ) : (
                  <div className="mt-2 max-h-48 divide-y divide-white/[0.05] overflow-y-auto rounded-xl border border-white/[0.07]">
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => onSelectModel(model.id)}
                        className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-white/[0.04] cursor-pointer ${
                          model.id === selectedModel ? 'bg-violet-500/[.12] font-medium text-white' : 'text-neutral-400'
                        }`}
                      >
                        <span className="truncate">{model.label}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${TIER_BADGE[model.tier]}`}>
                          {model.tier}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {/* Temperature Slider */}
              <section>
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Temperature</h3>
                  <span className="text-xs font-mono text-neutral-300">{temperature.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={temperature}
                  onChange={(event) => onTemperatureChange(parseFloat(event.target.value))}
                  className="mt-2 w-full accent-violet-400 cursor-pointer"
                />
                <div className="mt-1 flex justify-between text-[10px] text-neutral-600">
                  <span>Deterministic (0.0)</span>
                  <span>Creative (1.0)</span>
                </div>
              </section>
            </>
          )}

          {activeTab === 'PLAN' && (
            <>
              {/* Monthly Quota Meter Card */}
              <section className="space-y-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">
                      Monthly Quota Status
                    </div>
                    <div className="text-sm font-semibold text-white mt-0.5 flex items-center gap-2">
                      <span>{currentPlan.label}</span>
                      <span className="rounded border border-violet-300/25 bg-violet-500/[.12] px-1.5 py-0.5 text-[10px] font-normal uppercase text-violet-300">
                        Active
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-mono text-neutral-400">{usage.monthLabel}</span>
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-neutral-400">
                      Messages Used: <strong className="text-white">{usage.count}</strong> / {usage.isUnlimited ? 'Unlimited' : usage.limit}
                    </span>
                    <span className={usage.isCapReached ? 'text-rose-400 font-bold' : 'text-violet-300'}>
                      {usage.isUnlimited ? 'Unlimited' : usage.remaining} remaining
                    </span>
                  </div>

                  <div className="h-2 w-full overflow-hidden rounded-full border border-white/[0.09] bg-white/[0.04]">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        usage.isUnlimited
                          ? 'bg-violet-500'
                          : usage.isCapReached
                            ? 'bg-rose-500'
                            : usage.percentage >= 70
                              ? 'bg-amber-400'
                              : 'bg-violet-400'
                      }`}
                      style={{ width: usage.isUnlimited ? '100%' : `${usage.percentage}%` }}
                    />
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-between text-[11px] text-neutral-500 border-t border-white/[0.05]">
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-violet-300" />
                    Quota tracked per calendar month
                  </span>
                  <button
                    type="button"
                    onClick={() => resetMonthlyUsage()}
                    title="Reset message counter for testing"
                    className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-white transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset Quota (Test)
                  </button>
                </div>
              </section>

              <p className="text-[11px] text-neutral-400 leading-relaxed">
                Free plan is unlimited BYOK — no message cap and ₹0 cost to you and ShadRox. Paid tiers are
                locked during the beta; no upgrade or payment is processed yet.
              </p>

              {PLANS_LOCKED && (
                <div className="flex items-start gap-2 rounded-xl border border-violet-300/20 bg-violet-500/[.06] px-3 py-2.5 text-[11px] text-violet-200">
                  <Lock className="mt-0.5 w-3.5 h-3.5 shrink-0" />
                  <span>
                    Plans are locked for the beta. You stay on Free BYOK (unlimited messages with your own
                    key) and cannot switch to a paid tier.
                  </span>
                </div>
              )}

              {/* Plans Tier Cards */}
              <section className="space-y-3">
                {PLANS.map((entry) => {
                  const isCurrent = entry.id === plan;
                  return (
                    <div
                      key={entry.id}
                      className={`rounded-2xl border p-4 transition-colors ${
                        isCurrent
                          ? 'border-violet-300/30 bg-violet-500/[.06]'
                          : entry.popular
                            ? 'border-amber-500/25 bg-amber-500/[.04]'
                            : 'border-white/[0.07] bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-white">{entry.label}</span>
                            {isCurrent && (
                              <span className="rounded border border-violet-300/25 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-violet-300">
                                Current
                              </span>
                            )}
                            {entry.popular && !isCurrent && (
                              <span className="rounded border border-amber-500/30 bg-amber-500/[.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
                                Popular
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-violet-300 font-mono mt-0.5">
                            {entry.monthlyCap === Infinity ? 'Unlimited' : entry.monthlyCap} messages / month
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <div className="text-sm font-mono font-bold text-white">{entry.price}</div>
                          <div className="text-[9px] text-neutral-400">{entry.gstNote}</div>
                        </div>
                      </div>

                      <p className="mt-2 text-xs text-neutral-400 leading-relaxed">{entry.blurb}</p>

                      <ul className="mt-3 space-y-1.5">
                        {entry.perks.map((perk) => (
                          <li key={perk} className="flex items-start gap-1.5 text-xs text-neutral-300">
                            <Check className="mt-0.5 w-3.5 h-3.5 shrink-0 text-violet-400" />
                            <span>{perk}</span>
                          </li>
                        ))}
                      </ul>

                      <button
                        type="button"
                        onClick={() => onPlanChange(entry.id)}
                        disabled={isCurrent || PLANS_LOCKED}
                        className={`mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                          isCurrent
                            ? 'border border-white/10 text-neutral-600 bg-white/[.02] cursor-default'
                            : PLANS_LOCKED
                              ? 'border border-white/10 text-neutral-500 bg-white/[.02] cursor-not-allowed'
                              : entry.id === 'free'
                                ? 'border border-white/10 text-neutral-300 hover:bg-white/[.06] cursor-pointer'
                                : 'bg-violet-300 text-[#16121f] hover:bg-violet-200 cursor-pointer'
                        }`}
                      >
                        {PLANS_LOCKED && !isCurrent && <Lock className="w-3 h-3" />}
                        {isCurrent
                          ? 'Current Plan Active'
                          : PLANS_LOCKED
                            ? 'Locked during beta'
                            : entry.id === 'free'
                              ? 'Switch to Free (BYOK)'
                              : `Upgrade to ${entry.label}`}
                      </button>
                    </div>
                  );
                })}
              </section>
            </>
          )}

          {activeTab === 'GITHUB' && (
            <>
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Personal Access Token</h3>
                <p className="mt-1 text-[11px] text-neutral-400 leading-relaxed">
                  Provide a GitHub token with `repo` scope. The token is held in active browser memory only and never stored on a server.
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={githubToken}
                    onChange={(event) => setGithubToken(event.target.value)}
                    placeholder="ghp_..."
                    autoComplete="off"
                    className="flex-1 min-w-0 rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs font-mono text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-violet-300/40"
                  />
                  <button
                    type="button"
                    onClick={handleGithubConnect}
                    disabled={!githubToken.trim() || isCheckingGithub}
                    className="whitespace-nowrap rounded-xl border border-violet-300/25 bg-violet-500/[.08] px-3 py-2 text-xs text-violet-100 transition-colors hover:bg-violet-500/[.14] disabled:opacity-40 cursor-pointer"
                  >
                    {isCheckingGithub ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
                {githubMessage && (
                  <div
                    className={`mt-2 rounded-lg border px-3 py-2 text-[11px] ${
                      githubMessage.type === 'ok'
                        ? 'border-violet-300/25 bg-violet-500/[.07] text-violet-300'
                        : 'border-red-900/60 bg-red-950/20 text-red-400'
                    }`}
                  >
                    {githubMessage.text}
                  </div>
                )}
              </section>

              {githubUser && (
                <>
                  <section className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3">
                    <img src={githubUser.avatar_url} alt={githubUser.login} className="w-9 h-9 rounded-full" />
                    <div className="min-w-0">
                      <div className="text-xs text-white font-medium truncate">{githubUser.name}</div>
                      <div className="text-[11px] text-neutral-500">@{githubUser.login}</div>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Push Workspace</h3>
                    <div className="mt-2 space-y-2">
                      <select
                        value={targetRepo}
                        onChange={(event) => setTargetRepo(event.target.value)}
                        className="w-full cursor-pointer rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs text-neutral-200 outline-none transition-colors focus:border-violet-300/40"
                      >
                        <option value="">Select a repository</option>
                        {githubRepos.map((repo) => (
                          <option key={repo.full_name} value={repo.full_name}>
                            {repo.full_name} {repo.private ? '(private)' : ''}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-stretch gap-2">
                        <input
                          value={commitMessage}
                          onChange={(event) => setCommitMessage(event.target.value)}
                          placeholder="Commit message"
                          className="min-w-0 flex-1 rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs text-neutral-200 outline-none transition-colors focus:border-violet-300/40"
                        />
                        <button
                          type="button"
                          onClick={() => void handleWriteCommitMessage()}
                          disabled={isWritingCommitMessage || workspaceFiles.length === 0}
                          title="Write a commit message from the current git diff (or unsaved files)"
                          className="flex shrink-0 items-center gap-1 rounded-xl border border-violet-300/25 bg-violet-500/[.12] px-2.5 text-[11px] font-medium text-violet-200 transition-colors hover:bg-violet-500/20 disabled:opacity-40 cursor-pointer"
                        >
                          {isWritingCommitMessage ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="w-3.5 h-3.5" />
                          )}
                          {isWritingCommitMessage ? 'Writing' : 'AI message'}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={handleGithubPush}
                        disabled={!targetRepo || workspaceFiles.length === 0 || isPushing}
                        className="w-full rounded-xl bg-violet-300 py-2 text-xs font-semibold text-[#16121f] transition-colors hover:bg-violet-200 disabled:opacity-40 disabled:hover:bg-violet-300 cursor-pointer"
                      >
                        {isPushing ? 'Pushing...' : `Push ${workspaceFiles.length} file(s) to GitHub`}
                      </button>
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {activeTab === 'SECRETS' && (
            <>
              {/* Direct Secret Linking Notice — No .env file */}
              <section className="space-y-1.5 rounded-2xl border border-violet-300/25 bg-violet-500/[.07] p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-violet-300">
                  <ShieldCheck className="w-4 h-4 text-violet-300" />
                  ShadRox Secure Secrets Vault (Zero Disk Footprint)
                </div>
                <p className="text-[11px] text-neutral-300 leading-relaxed">
                  No <code className="text-violet-200 font-mono">.env</code> file is written to your disk or workspace. All secrets are linked directly into your active runtime and bundler (<code className="text-violet-200 font-mono">process.env</code> and <code className="text-violet-200 font-mono">import.meta.env</code>) and encrypted inside your browser session.
                </p>
              </section>

              {/* Add Secret Form */}
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
                  <Lock className="w-3 h-3" />
                  Add Environment Secret
                </h3>
                <div className="mt-2 flex gap-2">
                  <input
                    value={newSecretKey}
                    onChange={(event) => setNewSecretKey(event.target.value.toUpperCase())}
                    placeholder="VARIABLE_NAME"
                    className="w-2/5 rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs font-mono text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-violet-300/40"
                  />
                  <input
                    value={newSecretValue}
                    onChange={(event) => setNewSecretValue(event.target.value)}
                    placeholder="Secret value"
                    className="flex-1 min-w-0 rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs font-mono text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-violet-300/40"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!newSecretKey.trim()) return;
                      onSecretsChange([
                        ...secrets,
                        { id: `${Date.now()}`, key: newSecretKey.trim(), value: newSecretValue, visible: false }
                      ]);
                      setNewSecretKey('');
                      setNewSecretValue('');
                    }}
                    className="rounded-xl bg-violet-300 px-3 py-2 text-xs font-semibold text-[#16121f] transition-colors hover:bg-violet-200 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Common Presets */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {['DATABASE_URL', 'STRIPE_SECRET_KEY', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_API_URL'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setNewSecretKey(preset)}
                      className="rounded-md border border-white/[0.09] px-2 py-0.5 text-[10px] font-mono text-neutral-400 transition-colors hover:border-violet-300/30 hover:text-violet-200 cursor-pointer"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>

                {/* Secret Items List */}
                <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]">
                  {secrets.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-neutral-600 italic">No secrets configured in vault.</div>
                  ) : (
                    secrets.map((secret) => (
                      <div key={secret.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="w-2/5 shrink-0 text-[11px] font-mono text-violet-300 truncate">
                          {secret.key}
                        </span>
                        <span className="flex-1 min-w-0 text-[11px] font-mono text-neutral-400 truncate">
                          {secret.visible ? secret.value : '••••••••••••'}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            onSecretsChange(
                              secrets.map((item) =>
                                item.id === secret.id ? { ...item, visible: !item.visible } : item
                              )
                            )
                          }
                          title={secret.visible ? 'Hide secret' : 'Show secret'}
                          className="p-1 text-neutral-500 hover:text-white cursor-pointer"
                        >
                          {secret.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSecretsChange(secrets.filter((item) => item.id !== secret.id))}
                          title="Delete secret"
                          className="p-1 text-neutral-500 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
