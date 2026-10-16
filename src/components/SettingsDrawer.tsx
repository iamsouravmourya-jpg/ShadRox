import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Eye,
  EyeOff,
  ExternalLink,
  Github,
  Loader2,
  Lock,
  Plus,
  Trash2,
  X
} from 'lucide-react';
import { PROVIDERS, getProviderMeta, type ModelInfo, type ModelTier, type ProviderId } from '../lib/providers';
import type {
  GitHubRepo,
  GitHubUser,
  KeyStatus,
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
  useDevoraKey: boolean;
  onUseDevoraKeyChange: (value: boolean) => void;

  secrets: SecretItem[];
  onSecretsChange: (secrets: SecretItem[]) => void;

  workspaceFiles: WorkspaceFile[];
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'CHAT', label: 'Models & Keys' },
  { id: 'GITHUB', label: 'GitHub' },
  { id: 'SECRETS', label: 'Secrets' }
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
    useDevoraKey,
    onUseDevoraKeyChange,
    secrets,
    onSecretsChange,
    workspaceFiles
  } = props;

  // GitHub state lives inside the drawer because nothing outside needs it.
  const [githubToken, setGithubToken] = useState('');
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [isCheckingGithub, setIsCheckingGithub] = useState(false);
  const [githubMessage, setGithubMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [targetRepo, setTargetRepo] = useState('');
  const [commitMessage, setCommitMessage] = useState('Update from Devora');
  const [isPushing, setIsPushing] = useState(false);
  const [newSecretKey, setNewSecretKey] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');

  if (!isOpen) return null;

  const currentMeta = getProviderMeta(activeProvider);
  const currentStatus = keyStatus[activeProvider];
  const currentDraft = apiKeyDraft[activeProvider] || '';
  const currentSavedKey = currentDraft.length > 0;

  const handleGithubConnect = async () => {
    setIsCheckingGithub(true);
    setGithubMessage(null);
    try {
      const data = await postJson('/api/github/validate', { token: githubToken });
      setGithubUser(data.user as GitHubUser);
      setGithubRepos((data.repos || []) as GitHubRepo[]);
      if (!targetRepo && data.repos?.[0]?.name) setTargetRepo(data.repos[0].name);
      setGithubMessage({ type: 'ok', text: `Connected as ${data.user.login}` });
    } catch (error) {
      setGithubUser(null);
      setGithubRepos([]);
      setGithubMessage({ type: 'error', text: error instanceof Error ? error.message : 'GitHub connect failed.' });
    } finally {
      setIsCheckingGithub(false);
    }
  };

  const handleGithubPush = async () => {
    if (!githubUser || !targetRepo || workspaceFiles.length === 0) return;
    setIsPushing(true);
    setGithubMessage(null);
    try {
      const data = await postJson('/api/github/push', {
        token: githubToken,
        owner: githubUser.login,
        repo: targetRepo,
        files: workspaceFiles.map((file) => ({ name: file.name, content: file.content })),
        commitMessage
      });
      const failed = (data.results || []).filter((result: { status: string }) => result.status === 'failed');
      setGithubMessage({
        type: failed.length === 0 ? 'ok' : 'error',
        text:
          failed.length === 0
            ? `Pushed ${data.results.length} files → ${data.repoUrl}`
            : `${data.results.length - failed.length} pushed, ${failed.length} failed.`
      });
    } catch (error) {
      setGithubMessage({ type: 'error', text: error instanceof Error ? error.message : 'Push failed.' });
    } finally {
      setIsPushing(false);
    }
  };

  const freeModels = models.filter((model) => model.tier === 'free');
  const proModels = models.filter((model) => model.tier === 'pro');

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />

      <aside className="relative w-full sm:w-2/5 sm:min-w-[400px] h-full bg-black border-l border-neutral-900 flex flex-col">
        <header className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-neutral-900">
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
            aria-label="Close settings"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <nav className="shrink-0 flex border-b border-neutral-900">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`flex-1 py-2.5 text-[11px] uppercase tracking-wider transition-colors cursor-pointer ${
                activeTab === tab.id ? 'text-white border-b-2 border-white' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6">
          {activeTab === 'CHAT' && (
            <>
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Provider</h3>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {PROVIDERS.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => onProviderChange(provider.id)}
                      className={`border px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                        provider.id === activeProvider
                          ? 'border-white text-white'
                          : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'
                      }`}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">
                  {currentMeta.label} API key (BYOK)
                </h3>
                <p className="mt-1 text-[11px] text-neutral-600">
                  {currentMeta.keyHint}. Key sirf tumhare browser me save hoti hai.
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
                    {currentStatus?.state === 'checking' ? 'Testing...' : 'Save & test'}
                  </button>
                </div>

                {currentStatus && currentStatus.state !== 'idle' && (
                  <div
                    role="status"
                    aria-live="polite"
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
                        ? `${currentMeta.label} key valid — ${currentStatus.modelCount} models mile (${currentStatus.latencyMs}ms).`
                        : currentStatus.state === 'error'
                          ? `Error: ${currentStatus.message}`
                          : 'Key test ho rahi hai...'}
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
                    Key kaha se le <ExternalLink className="w-3 h-3" />
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

              <section className="border border-neutral-900 p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useDevoraKey}
                    onChange={(event) => onUseDevoraKeyChange(event.target.checked)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <span>
                    <span className="block text-xs text-neutral-200">Devora ki shared key use karo</span>
                    <span className="block text-[11px] text-neutral-600 mt-0.5">
                      Bina BYOK ke chalane ke liye. Isse request hamare serverless proxy se jaati hai — isliye plan ka
                      hona zaroori hai.
                    </span>
                  </span>
                </label>
              </section>

              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Available models {models.length > 0 && `(${models.length})`}
                </h3>
                {models.length === 0 ? (
                  <p className="mt-2 text-[11px] text-neutral-600">
                    Key save karke test karo — jo models us key par chalenge wo free/pro me divide ho kar yahan dikhenge.
                  </p>
                ) : (
                  <div className="mt-2 space-y-4">
                    {([
                      ['free', 'Free models', freeModels],
                      ['pro', 'Pro models', proModels]
                    ] as Array<[ModelTier, string, ModelInfo[]]>).map(([tier, label, list]) =>
                      list.length === 0 ? null : (
                        <div key={tier}>
                          <div className="text-[10px] uppercase tracking-wider text-neutral-600 mb-1">{label}</div>
                          <div className="border border-neutral-900 divide-y divide-neutral-900">
                            {list.map((model) => (
                              <button
                                key={model.id}
                                type="button"
                                onClick={() => onSelectModel(model.id)}
                                className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-950 transition-colors cursor-pointer ${
                                  model.id === selectedModel ? 'text-white' : 'text-neutral-400'
                                }`}
                              >
                                <span className="truncate">{model.label}</span>
                                <span className={`ml-2 shrink-0 border px-1.5 py-0.5 text-[10px] uppercase ${TIER_BADGE[tier]}`}>
                                  {tier}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}
              </section>

              <section>
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Temperature</h3>
                  <span className="text-xs text-neutral-300 font-mono">{temperature.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => onTemperatureChange(Number(event.target.value))}
                  className="mt-2 w-full accent-emerald-500"
                />
              </section>
            </>
          )}

          {activeTab === 'GITHUB' && (
            <>
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Personal access token</h3>
                <p className="mt-1 text-[11px] text-neutral-600">
                  `repo` scope wala token chahiye. Token sirf is session me memory me rehta hai, save nahi hota.
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
                    {isCheckingGithub ? 'Checking...' : 'Connect'}
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
                  <section className="flex items-center gap-3 border border-neutral-900 p-3">
                    <img src={githubUser.avatar_url} alt={githubUser.login} className="w-9 h-9 rounded-full" />
                    <div className="min-w-0">
                      <div className="text-xs text-white truncate">{githubUser.name}</div>
                      <div className="text-[11px] text-neutral-500">@{githubUser.login}</div>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Push workspace</h3>
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
                        {isPushing ? 'Pushing...' : `Push ${workspaceFiles.length} files`}
                      </button>
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {activeTab === 'SECRETS' && (
            <>
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
                  <Lock className="w-3 h-3" />
                  Local secrets
                </h3>
                <p className="mt-1 text-[11px] text-neutral-600">
                  Ye sirf tumhare browser me rehti hain aur AI ke context me bheji ja sakti hain. Server par kuch save nahi
                  hota.
                </p>

                <div className="mt-3 flex gap-2">
                  <input
                    value={newSecretKey}
                    onChange={(event) => setNewSecretKey(event.target.value)}
                    placeholder="KEY"
                    className="w-1/3 bg-black border border-neutral-800 px-2 py-2 text-xs font-mono text-neutral-100 outline-none placeholder:text-neutral-700"
                  />
                  <input
                    value={newSecretValue}
                    onChange={(event) => setNewSecretValue(event.target.value)}
                    placeholder="value"
                    className="flex-1 min-w-0 bg-black border border-neutral-800 px-2 py-2 text-xs font-mono text-neutral-100 outline-none placeholder:text-neutral-700"
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
                    className="px-3 py-2 border border-neutral-700 text-xs text-white hover:bg-neutral-900 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="mt-3 border border-neutral-900 divide-y divide-neutral-900">
                  {secrets.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-neutral-600">Koi secret nahi.</div>
                  ) : (
                    secrets.map((secret) => (
                      <div key={secret.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="w-1/3 shrink-0 text-[11px] font-mono text-neutral-300 truncate">{secret.key}</span>
                        <span className="flex-1 min-w-0 text-[11px] font-mono text-neutral-500 truncate">
                          {secret.visible ? secret.value : '••••••••'}
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
                          className="text-neutral-600 hover:text-white cursor-pointer"
                        >
                          {secret.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSecretsChange(secrets.filter((item) => item.id !== secret.id))}
                          className="text-neutral-600 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="flex items-center gap-2 text-[11px] text-neutral-600">
                <Github className="w-3.5 h-3.5" />
                <span>GitHub aur secrets tab alag rakhe gaye hain taaki cheezein clear rahein.</span>
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
