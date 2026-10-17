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
import { PLANS, getPlanMeta } from '../lib/plans';
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
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'CHAT', label: 'Models & Keys' },
  { id: 'PLAN', label: 'Subscription Plan' },
  { id: 'GITHUB', label: 'GitHub Sync' },
  { id: 'SECRETS', label: 'Secrets Vault' }
];

const TIER_BADGE: Record<ModelTier, string> = {
  free: 'text-emerald-400 border-emerald-900/60',
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
    workspaceFiles
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

  if (!isOpen) return null;

  const currentMeta = getProviderMeta(activeProvider);
  const currentDraft = apiKeyDraft[activeProvider] ?? '';
  const currentStatus = keyStatus[activeProvider];
  const currentSavedKey = currentStatus && currentStatus.state === 'ok';
  const currentPlan = getPlanMeta(plan);

  const handleGithubConnect = async () => {
    if (!githubToken.trim()) return;
    setIsCheckingGithub(true);
    setGithubMessage(null);
    try {
      const data = await postJson('/api/github/check', { token: githubToken });
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

  const handleGithubPush = async () => {
    if (!targetRepo || workspaceFiles.length === 0) return;
    setIsPushing(true);
    setGithubMessage(null);
    try {
      const data = await postJson('/api/github/push', {
        token: githubToken,
        repo: targetRepo,
        message: commitMessage || 'Update from ShadRox IDE',
        files: workspaceFiles
      });
      setGithubMessage({
        type: 'ok',
        text: `Committed ${workspaceFiles.length} file(s) to ${targetRepo} (${data.commitSha ? data.commitSha.slice(0, 7) : 'latest'}).`
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm">
      <aside className="w-full max-w-xl h-full bg-black border-l border-neutral-900 flex flex-col text-white shadow-2xl">
        {/* Header */}
        <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-neutral-900">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-300">
              ShadRox Settings
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Tabs */}
        <nav className="shrink-0 flex border-b border-neutral-900">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`flex-1 py-2.5 text-xs text-center border-b-2 transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'border-white text-white font-medium'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6">
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
                      className={`border px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                        provider.id === activeProvider
                          ? 'border-white text-white bg-neutral-950'
                          : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'
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
                  {currentMeta.keyHint}. Keys are securely stored in your local browser storage.
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={currentDraft}
                    onChange={(event) => onApiKeyDraftChange(activeProvider, event.target.value)}
                    placeholder={currentMeta.keyPlaceholder}
                    autoComplete="off"
                    className="flex-1 min-w-0 bg-black border border-neutral-800 focus:border-neutral-600 px-3 py-2 text-xs font-mono text-neutral-100 outline-none placeholder:text-neutral-700"
                  />
                  <button
                    type="button"
                    onClick={() => onValidateKey(activeProvider)}
                    disabled={currentStatus?.state === 'checking'}
                    className="px-3 py-2 border border-neutral-700 text-xs text-white hover:bg-neutral-900 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {currentStatus?.state === 'checking' ? 'Testing...' : 'Save & Test'}
                  </button>
                </div>

                {currentStatus && currentStatus.state !== 'idle' && (
                  <div
                    role="status"
                    className={`mt-2 flex items-start gap-2 px-3 py-2 text-[11px] leading-relaxed border ${
                      currentStatus.state === 'ok'
                        ? 'border-emerald-900/60 bg-emerald-950/20 text-emerald-400'
                        : currentStatus.state === 'error'
                          ? 'border-red-900/60 bg-red-950/20 text-red-400'
                          : 'border-neutral-800 text-neutral-400'
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

                <div className="mt-2 flex items-center justify-between">
                  <a
                    href={currentMeta.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-white"
                  >
                    Get API key <ExternalLink className="w-3 h-3" />
                  </a>
                  {currentSavedKey && (
                    <button
                      type="button"
                      onClick={() => onForgetKey(activeProvider)}
                      className="text-[11px] text-neutral-600 hover:text-red-400 cursor-pointer"
                    >
                      Remove key
                    </button>
                  )}
                </div>
              </section>

              {/* Shared Key Option */}
              <section className="border border-neutral-900 p-3 bg-neutral-950/40">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useShadRoxKey}
                    onChange={(event) => onUseShadRoxKeyChange(event.target.checked)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-neutral-200 font-medium">Use ShadRox Shared Key</span>
                      <span className="shrink-0 border border-amber-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                        Pro
                      </span>
                    </span>
                    <span className="block text-[11px] text-neutral-400 mt-1">
                      Run directly without bringing your own API key. Requests flow through our secure proxy for Pro-tier models.
                    </span>
                  </span>
                </label>
                {plan === 'free' && (
                  <button
                    type="button"
                    onClick={() => onPlanChange('pro')}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 border border-amber-900/60 py-2 text-[11px] text-amber-400 hover:bg-amber-950/30 transition-colors cursor-pointer font-medium"
                  >
                    <Zap className="w-3 h-3" />
                    Upgrade to Pro (₹499/mo GST Included)
                  </button>
                )}
              </section>

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
                  <div className="mt-2 border border-neutral-900 divide-y divide-neutral-900 max-h-48 overflow-y-auto">
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => onSelectModel(model.id)}
                        className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-900 cursor-pointer ${
                          model.id === selectedModel ? 'bg-neutral-900 text-white font-medium' : 'text-neutral-400'
                        }`}
                      >
                        <span className="truncate">{model.label}</span>
                        <span className={`px-1.5 py-0.5 border text-[9px] uppercase tracking-wider ${TIER_BADGE[model.tier]}`}>
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
                  className="mt-2 w-full accent-emerald-500 cursor-pointer"
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
              <section className="border border-neutral-900 bg-neutral-950/70 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">
                      Monthly Quota Status
                    </div>
                    <div className="text-sm font-semibold text-white mt-0.5 flex items-center gap-2">
                      <span>{currentPlan.label}</span>
                      <span className="border border-emerald-900/60 bg-emerald-950/40 text-emerald-400 text-[10px] uppercase px-1.5 py-0.5 font-normal">
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
                      Messages Used: <strong className="text-white">{usage.count}</strong> / {usage.limit}
                    </span>
                    <span className={usage.isCapReached ? 'text-rose-400 font-bold' : 'text-emerald-400'}>
                      {usage.remaining} remaining
                    </span>
                  </div>

                  <div className="h-2 w-full bg-neutral-900 overflow-hidden border border-neutral-800">
                    <div
                      className={`h-full transition-all duration-300 ${
                        usage.isCapReached
                          ? 'bg-rose-500'
                          : usage.percentage >= 70
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                      }`}
                      style={{ width: `${usage.percentage}%` }}
                    />
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-between text-[11px] text-neutral-500 border-t border-neutral-900/70">
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
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
                Free plan includes 100 messages/month. Pro plan offers 250 messages and Advanced offers 500 messages with all GST included.
              </p>

              {/* Plans Tier Cards */}
              <section className="space-y-3">
                {PLANS.map((entry) => {
                  const isCurrent = entry.id === plan;
                  return (
                    <div
                      key={entry.id}
                      className={`border p-4 transition-colors ${
                        isCurrent
                          ? 'border-white bg-neutral-950/60'
                          : entry.popular
                            ? 'border-amber-900/60 bg-neutral-950/30'
                            : 'border-neutral-900 bg-neutral-950/20'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-white">{entry.label}</span>
                            {isCurrent && (
                              <span className="border border-emerald-900/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-400">
                                Current
                              </span>
                            )}
                            {entry.popular && !isCurrent && (
                              <span className="border border-amber-900/60 bg-amber-950/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-400 font-semibold">
                                Popular
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-emerald-400 font-mono mt-0.5">
                            {entry.monthlyCap} messages / month
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
                            <Check className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-500" />
                            <span>{perk}</span>
                          </li>
                        ))}
                      </ul>

                      <button
                        type="button"
                        onClick={() => onPlanChange(entry.id)}
                        disabled={isCurrent}
                        className={`mt-4 w-full py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                          isCurrent
                            ? 'border border-neutral-900 text-neutral-600 bg-black cursor-default'
                            : entry.id === 'free'
                              ? 'border border-neutral-800 text-neutral-300 hover:bg-neutral-900 cursor-pointer'
                              : 'bg-white text-black hover:bg-neutral-200 cursor-pointer'
                        }`}
                      >
                        {isCurrent ? 'Current Plan Active' : entry.id === 'free' ? 'Switch to Free (BYOK)' : `Upgrade to ${entry.label}`}
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
                    className="flex-1 min-w-0 bg-black border border-neutral-800 focus:border-neutral-600 px-3 py-2 text-xs font-mono text-neutral-100 outline-none placeholder:text-neutral-700"
                  />
                  <button
                    type="button"
                    onClick={handleGithubConnect}
                    disabled={!githubToken.trim() || isCheckingGithub}
                    className="px-3 py-2 border border-neutral-700 text-xs text-white hover:bg-neutral-900 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {isCheckingGithub ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
                {githubMessage && (
                  <div
                    className={`mt-2 px-3 py-2 text-[11px] border ${
                      githubMessage.type === 'ok'
                        ? 'border-emerald-900/60 bg-emerald-950/20 text-emerald-400'
                        : 'border-red-900/60 bg-red-950/20 text-red-400'
                    }`}
                  >
                    {githubMessage.text}
                  </div>
                )}
              </section>

              {githubUser && (
                <>
                  <section className="flex items-center gap-3 border border-neutral-900 p-3 bg-neutral-950">
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
                        className="w-full bg-black border border-neutral-800 px-3 py-2 text-xs text-neutral-200 outline-none cursor-pointer"
                      >
                        <option value="">Select a repository</option>
                        {githubRepos.map((repo) => (
                          <option key={repo.full_name} value={repo.name}>
                            {repo.full_name} {repo.private ? '(private)' : ''}
                          </option>
                        ))}
                      </select>
                      <input
                        value={commitMessage}
                        onChange={(event) => setCommitMessage(event.target.value)}
                        placeholder="Commit message"
                        className="w-full bg-black border border-neutral-800 px-3 py-2 text-xs text-neutral-200 outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleGithubPush}
                        disabled={!targetRepo || workspaceFiles.length === 0 || isPushing}
                        className="w-full py-2 bg-white text-black text-xs font-semibold hover:bg-neutral-200 disabled:opacity-40 transition-colors cursor-pointer"
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
              <section className="border border-emerald-900/60 bg-emerald-950/20 p-3 space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  ShadRox Secure Secrets Vault (Zero Disk Footprint)
                </div>
                <p className="text-[11px] text-neutral-300 leading-relaxed">
                  No <code className="text-emerald-300 font-mono">.env</code> file is written to your disk or workspace. All secrets are linked directly into your active runtime and bundler (<code className="text-emerald-300 font-mono">process.env</code> and <code className="text-emerald-300 font-mono">import.meta.env</code>) and encrypted inside your browser session.
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
                    className="w-2/5 bg-black border border-neutral-800 px-3 py-2 text-xs font-mono text-neutral-100 outline-none placeholder:text-neutral-700"
                  />
                  <input
                    value={newSecretValue}
                    onChange={(event) => setNewSecretValue(event.target.value)}
                    placeholder="Secret value"
                    className="flex-1 min-w-0 bg-black border border-neutral-800 px-3 py-2 text-xs font-mono text-neutral-100 outline-none placeholder:text-neutral-700"
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
                    className="px-3 py-2 bg-white text-black hover:bg-neutral-200 text-xs font-semibold transition-colors cursor-pointer"
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
                      className="px-2 py-0.5 border border-neutral-800 hover:border-neutral-700 text-[10px] font-mono text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>

                {/* Secret Items List */}
                <div className="mt-4 border border-neutral-900 divide-y divide-neutral-900 bg-neutral-950">
                  {secrets.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-neutral-600 italic">No secrets configured in vault.</div>
                  ) : (
                    secrets.map((secret) => (
                      <div key={secret.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="w-2/5 shrink-0 text-[11px] font-mono text-emerald-400 truncate">
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
