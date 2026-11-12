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
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import { PROVIDERS, ENDPOINT_PRESETS, findEndpointPreset, getProviderMeta, normalizeBaseUrl, type ProviderId } from '../lib/providers';
import { usesEncryptedSecrets } from '../lib/secureStore';
import { confirmAction } from '../lib/confirm';
import { McpToolsSection } from './settings/McpToolsSection';
import { PluginsSection } from './settings/PluginsSection';
import { AutomationsSection } from './settings/AutomationsSection';
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

  /** Custom endpoint configuration. Only rendered when the provider is `custom`. */
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  extraModels: string[];
  onExtraModelsChange: (modelIds: string[]) => void;

  secrets: SecretItem[];
  onSecretsChange: (secrets: SecretItem[]) => void;

  workspaceFiles: WorkspaceFile[];
  onGenerateCommitMessage: () => Promise<string>;
  isWritingCommitMessage: boolean;

  /** Native workspace id for the Plugins and Automations sections. */
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'CHAT', label: 'Models & Keys' },
  { id: 'GITHUB', label: 'GitHub Sync' },
  { id: 'SECRETS', label: 'Secrets Vault' },
  { id: 'TOOLS', label: 'MCP Tools' },
  { id: 'AUTOMATIONS', label: 'Plugins & Automations' }
];

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
    baseUrl,
    onBaseUrlChange,
    extraModels,
    onExtraModelsChange,
    secrets,
    onSecretsChange,
    workspaceFiles,
    onGenerateCommitMessage,
    isWritingCommitMessage,
    workspaceId,
    workspaceRoot
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

  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl);
  const [extraModelsDraft, setExtraModelsDraft] = useState(extraModels.join(', '));

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
  const docsHref =
    activeProvider === 'custom'
      ? findEndpointPreset(baseUrlDraft)?.docsUrl ?? currentMeta.docsUrl
      : currentMeta.docsUrl;
  const keyDestination = activeProvider === 'custom' ? 'your endpoint' : currentMeta.label;
  // Desktop has an OS-encrypted secret store; a browser build has only plaintext localStorage.
  const keyStorageLine = usesEncryptedSecrets()
    ? `Saved on this device in the OS-encrypted store (Windows DPAPI); this app's local server and ${keyDestination} are the only things that ever see it.`
    : `Saved in this browser's local storage as plain text; this app's local server and ${keyDestination} are the only things that ever see it.`;
  const currentStatus = keyStatus[activeProvider];
  const currentSavedKey = currentStatus && currentStatus.state === 'ok';
  const hasStoredKey = currentDraft.trim().length > 0 || currentSavedKey;

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

        {/* Tabs — wrapped rather than scrolled so every section stays reachable
            at 1440px, where a single row used to clip the last tab. */}
        <nav aria-label="Settings sections" className="flex shrink-0 flex-wrap border-b border-white/[0.07]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-center text-xs transition-colors cursor-pointer ${
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
          {activeTab === 'CHAT' && (
            <>
              {/* Provider Selection */}
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">AI Provider</h3>
                <div className="mt-2 grid grid-cols-3 gap-2">
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

              {currentMeta.needsBaseUrl && (
                <section>
                  <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Endpoint</h3>
                  <p className="mt-1 text-[11px] text-neutral-400">
                    Any OpenAI-compatible server. Choose a preset or paste your own base URL — ShadRox calls
                    /models and /chat/completions on it.
                  </p>
                  <select
                    value={findEndpointPreset(baseUrlDraft)?.id ?? 'custom'}
                    onChange={(event) => {
                      const preset = ENDPOINT_PRESETS.find((entry) => entry.id === event.target.value);
                      if (preset) {
                        setBaseUrlDraft(preset.baseUrl);
                        onBaseUrlChange(preset.baseUrl);
                      }
                    }}
                    className="mt-2 w-full rounded-xl border border-white/[0.09] bg-ink-900 px-3 py-2 text-xs text-neutral-100 outline-none focus:border-violet-300/40"
                  >
                    {ENDPOINT_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">Custom / other gateway</option>
                  </select>
                  <input
                    type="text"
                    value={baseUrlDraft}
                    onChange={(event) => setBaseUrlDraft(event.target.value)}
                    onBlur={() => {
                      // Commit the normalised form so what is stored is what the
                      // server will call (scheme added, trailing slash dropped).
                      const committed = normalizeBaseUrl(baseUrlDraft);
                      setBaseUrlDraft(committed);
                      onBaseUrlChange(committed);
                    }}
                    placeholder="https://your-gateway.example.com/v1"
                    spellCheck={false}
                    autoComplete="off"
                    className="mt-2 w-full rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs font-mono text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-violet-300/40"
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Local servers (Ollama, LM Studio) work over http on your own machine. The URL is saved in
                    plain settings — it is not a secret. The key is still stored as a secret ({usesEncryptedSecrets() ? 'OS-encrypted store' : "this browser's local storage"}).
                  </p>
                  <label className="mt-3 block text-[11px] uppercase tracking-wider text-neutral-500">
                    Model ids (optional)
                  </label>
                  <input
                    type="text"
                    value={extraModelsDraft}
                    onChange={(event) => setExtraModelsDraft(event.target.value)}
                    onBlur={() =>
                      onExtraModelsChange(
                        extraModelsDraft
                          .split(',')
                          .map((entry) => entry.trim())
                          .filter(Boolean)
                      )
                    }
                    placeholder="meta-llama/Llama-3.3-70B, deepseek-v3"
                    spellCheck={false}
                    autoComplete="off"
                    className="mt-1 w-full rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs font-mono text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-violet-300/40"
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Comma-separated. Needed only when the endpoint does not list models; these ids are added to
                    the picker.
                  </p>
                </section>
              )}

              {/* API Key Input */}
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">
                  {currentMeta.label} API Key (BYOK)
                </h3>
                <p className="mt-1 text-[11px] text-neutral-400">
                  {currentMeta.keyHint}. {keyStorageLine}
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
                    href={docsHref}
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
                        void (async () => {
                          const confirmed = await confirmAction({
                            title: `Remove your ${currentMeta.label} API key?`,
                            body: `The saved ${currentMeta.label} key is deleted from this device. You can add it again at any time.`,
                            confirmLabel: 'Remove key',
                            tone: 'danger'
                          });
                          if (!confirmed) return;
                          onForgetKey(activeProvider);
                        })();
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-white/[0.09] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-red-500/40 hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove saved key
                    </button>
                  )}
                </div>
              </section>

              {/* BYOK: what ShadRox does and does not send anywhere. */}
              <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 text-neutral-200">
                  <ShieldCheck className="h-4 w-4 text-violet-300" />
                  <span className="text-xs font-semibold">Your key runs every request</span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">
                  ShadRox has no paid plan and no shared key of its own, so there is nothing to switch on here.
                  Your project files stay on this device — nothing is synced to a ShadRox server. What does leave
                  is the prompt you send plus the code context attached to it, which goes straight to the provider
                  whose key is saved above.
                </p>
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

              {/* Disconnected state used to be a single row and ~600px of blank
                  panel. Spell out what the connection does instead. */}
              {!githubUser && (
                <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
                  <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">What connecting does</h3>
                  <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-neutral-400">
                    <li className="flex gap-2">
                      <span className="mt-0.5 font-mono text-neutral-600">1</span>
                      <span>The token is only used for two calls: list your repositories, and push one commit. Nothing else leaves this app.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-0.5 font-mono text-neutral-600">2</span>
                      <span>It lives in this window's memory for the session and is not written to disk, localStorage or the workspace.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-0.5 font-mono text-neutral-600">3</span>
                      <span>
                        A push uploads the {workspaceFiles.length} file buffer{workspaceFiles.length === 1 ? '' : 's'} the
                        editor currently holds — open some files first if the count looks short.
                      </span>
                    </li>
                  </ul>
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo&description=ShadRox"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-violet-300 transition-colors hover:text-violet-200"
                  >
                    Create a `repo` token on GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </section>
              )}

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
                  No <code className="text-violet-200 font-mono">.env</code> file is written to your disk or workspace. All secrets are kept only in this app session's memory — never encrypted to disk, never persisted — and injected directly into your active runtime and bundler (<code className="text-violet-200 font-mono">process.env</code> and <code className="text-violet-200 font-mono">import.meta.env</code>).
                </p>
              </section>

              {/* Where a secret actually goes — the honest scope, not a blank panel. */}
              <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
                <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Where a secret goes</h3>
                <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-neutral-400">
                  <li className="flex gap-2">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-violet-400" />
                    <span>Injected into the in-app preview bundle as <code className="font-mono text-violet-200">process.env</code> / <code className="font-mono text-violet-200">import.meta.env</code>.</span>
                  </li>
                  <li className="flex gap-2">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-violet-400" />
                    <span>Their names (never values) are listed to the model so it can write code that reads them.</span>
                  </li>
                  <li className="flex gap-2">
                    <X className="mt-0.5 h-3 w-3 shrink-0 text-neutral-600" />
                    <span>Not written to <code className="font-mono">.env</code>, not sent to GitHub push, and not passed to the terminal — restarting ShadRox clears the vault.</span>
                  </li>
                </ul>
              </section>
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

          {activeTab === 'TOOLS' && <McpToolsSection workspaceId={workspaceId} />}

          {activeTab === 'AUTOMATIONS' && (
            <>
              <PluginsSection workspaceId={workspaceId} workspaceRoot={workspaceRoot} />
              <AutomationsSection workspaceId={workspaceId} workspaceRoot={workspaceRoot} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
