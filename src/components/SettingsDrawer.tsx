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

  /** Native workspace id for MCP tools. */
  workspaceId?: string | null;
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'CHAT', label: 'Models & Keys' },
  { id: 'GITHUB', label: 'GitHub Sync' },
  { id: 'SECRETS', label: 'Secrets Vault' },
  { id: 'TOOLS', label: 'MCP Tools' }
];

async function postJson<TResponse>(url: string, body: unknown): Promise<TResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string } & TResponse;
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
    workspaceId
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
  // Desktop uses OS-backed safeStorage; browser mode encrypts via WebCrypto AES-GCM + non-extractable IndexedDB key.
  const keyStorageLine = usesEncryptedSecrets()
    ? `Saved on this device in the OS-encrypted store; this app's local server and ${keyDestination} are the only things that ever see it.`
    : `Encrypted in this browser (WebCrypto AES-GCM with a non-extractable IndexedDB key); this app's local server and ${keyDestination} are the only things that ever see it.`;
  const currentStatus = keyStatus[activeProvider];
  const currentSavedKey = currentStatus && currentStatus.state === 'ok';
  const hasStoredKey = currentDraft.trim().length > 0 || currentSavedKey;

  const handleGithubConnect = async () => {
    if (!githubToken.trim()) return;
    setIsCheckingGithub(true);
    setGithubMessage(null);
    try {
      const data = await postJson<{ user: GitHubUser; repos?: GitHubRepo[] }>('/api/github/validate', { token: githubToken });
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
      const data = await postJson<{ results?: Array<{ file: string; status?: string; error?: string | null }> }>('/api/github/push', {
        token: githubToken,
        owner,
        repo: repoName,
        commitMessage: commitMessage || 'Update from ShadRox IDE',
        files: workspaceFiles.map((file) => ({ name: file.name, content: file.content }))
      });
      const failed = (data.results ?? []).filter((result) => result.status !== 'success');
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
      className="fixed inset-x-0 bottom-0 top-12 z-50 flex justify-end bg-[var(--scrim)] backdrop-blur-md"
      onClick={onClose}
    >
      <aside
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col border-l border-line bg-base text-ink shadow-[-24px_0_60px_rgb(0_0_0/.45)]"
      >
        {/* Header */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-2">
              ShadRox Settings
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close settings (Esc)"
            aria-label="Close settings"
            className="flex items-center gap-1 rounded-md p-1 text-ink-4 hover:bg-overlay-2 hover:text-ink transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Tabs — wrapped rather than scrolled so every section stays reachable
            at 1440px, where a single row used to clip the last tab. */}
        <nav aria-label="Settings sections" className="flex shrink-0 flex-wrap border-b border-line">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-center text-xs transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'border-[var(--accent)] font-medium text-ink'
                  : 'border-transparent text-ink-4 hover:text-ink-3'
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
                <h3 className="text-[11px] uppercase tracking-wider text-ink-4">AI Provider</h3>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {PROVIDERS.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => onProviderChange(provider.id)}
                      className={`rounded-xl border px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                        provider.id === activeProvider
                          ? 'border-accent-line bg-accent-soft text-accent'
                          : 'border-line text-ink-3 hover:border-line-2 hover:text-ink-2'
                      }`}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              </section>

              {currentMeta.needsBaseUrl && (
                <section>
                  <h3 className="text-[11px] uppercase tracking-wider text-ink-4">Endpoint</h3>
                  <p className="mt-1 text-[11px] text-ink-3">
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
                    className="mt-2 w-full rounded-xl border border-line bg-base-2 px-3 py-2 text-xs text-ink outline-none focus:border-accent-line"
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
                    className="mt-2 w-full rounded-xl border border-line bg-overlay px-3 py-2 text-xs font-mono text-ink outline-none transition-colors placeholder:text-ink-5 focus:border-accent-line"
                  />
                  <p className="mt-1 text-[11px] text-ink-4">
                    Local servers (Ollama, LM Studio) work over http on your own machine. The URL is saved in
                    plain settings — it is not a secret. The key is still stored as a secret ({usesEncryptedSecrets() ? 'OS-encrypted store' : "this browser's local storage"}).
                  </p>
                  <label className="mt-3 block text-[11px] uppercase tracking-wider text-ink-4">
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
                    className="mt-1 w-full rounded-xl border border-line bg-overlay px-3 py-2 text-xs font-mono text-ink outline-none transition-colors placeholder:text-ink-5 focus:border-accent-line"
                  />
                  <p className="mt-1 text-[11px] text-ink-4">
                    Comma-separated. Needed only when the endpoint does not list models; these ids are added to
                    the picker.
                  </p>
                </section>
              )}

              {/* API Key Input */}
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-ink-4">
                  {currentMeta.label} API Key (BYOK)
                </h3>
                <p className="mt-1 text-[11px] text-ink-3">
                  {currentMeta.keyHint}. {keyStorageLine}
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={currentDraft}
                    onChange={(event) => onApiKeyDraftChange(activeProvider, event.target.value)}
                    placeholder={currentMeta.keyPlaceholder}
                    autoComplete="off"
                    className="flex-1 min-w-0 rounded-xl border border-line bg-overlay px-3 py-2 text-xs font-mono text-ink outline-none transition-colors placeholder:text-ink-5 focus:border-accent-line"
                  />
                  <button
                    type="button"
                    onClick={() => onValidateKey(activeProvider)}
                    disabled={currentStatus?.state === 'checking'}
                    className="whitespace-nowrap rounded-xl border border-accent-line bg-accent-soft px-3 py-2 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-40 cursor-pointer"
                  >
                    {currentStatus?.state === 'checking' ? 'Testing...' : 'Save & Test'}
                  </button>
                </div>

                {currentStatus && currentStatus.state !== 'idle' && (
                  <div
                    role="status"
                    className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                      currentStatus.state === 'ok'
                        ? 'border-accent-line bg-accent-soft text-accent'
                        : currentStatus.state === 'error'
                          ? 'border-danger/30 bg-danger/10 text-danger'
                          : 'border-line text-ink-3'
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
                    className="inline-flex items-center gap-1 text-[11px] text-ink-4 hover:text-ink"
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
                      className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-3 transition-colors hover:border-danger/40 hover:text-danger cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove saved key
                    </button>
                  )}
                </div>
              </section>

              {/* BYOK: what ShadRox does and does not send anywhere. */}
              <section className="rounded-2xl border border-line bg-overlay p-3">
                <div className="flex items-center gap-2 text-ink-2">
                  <ShieldCheck className="h-4 w-4 text-accent" />
                  <span className="text-xs font-semibold">Your key runs every request</span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
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
                <h3 className="text-[11px] uppercase tracking-wider text-ink-4">Personal Access Token</h3>
                <p className="mt-1 text-[11px] text-ink-3 leading-relaxed">
                  Provide a GitHub token with `repo` scope. The token is held in active browser memory only and never stored on a server.
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={githubToken}
                    onChange={(event) => setGithubToken(event.target.value)}
                    placeholder="ghp_..."
                    autoComplete="off"
                    className="flex-1 min-w-0 rounded-xl border border-line bg-overlay px-3 py-2 text-xs font-mono text-ink outline-none transition-colors placeholder:text-ink-5 focus:border-accent-line"
                  />
                  <button
                    type="button"
                    onClick={handleGithubConnect}
                    disabled={!githubToken.trim() || isCheckingGithub}
                    className="whitespace-nowrap rounded-xl border border-accent-line bg-accent-soft px-3 py-2 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-40 cursor-pointer"
                  >
                    {isCheckingGithub ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
                {githubMessage && (
                  <div
                    className={`mt-2 rounded-lg border px-3 py-2 text-[11px] ${
                      githubMessage.type === 'ok'
                        ? 'border-accent-line bg-accent-soft text-accent'
                        : 'border-danger/30 bg-danger/10 text-danger'
                    }`}
                  >
                    {githubMessage.text}
                  </div>
                )}
              </section>

              {/* Disconnected state used to be a single row and ~600px of blank
                  panel. Spell out what the connection does instead. */}
              {!githubUser && (
                <section className="rounded-2xl border border-line bg-overlay p-3">
                  <h3 className="text-[11px] uppercase tracking-wider text-ink-4">What connecting does</h3>
                  <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-ink-3">
                    <li className="flex gap-2">
                      <span className="mt-0.5 font-mono text-ink-5">1</span>
                      <span>The token is only used for two calls: list your repositories, and push one commit. Nothing else leaves this app.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-0.5 font-mono text-ink-5">2</span>
                      <span>It lives in this window's memory for the session and is not written to disk, localStorage or the workspace.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-0.5 font-mono text-ink-5">3</span>
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
                    className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-accent transition-colors hover:text-ink"
                  >
                    Create a `repo` token on GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </section>
              )}

              {githubUser && (
                <>
                  <section className="flex items-center gap-3 rounded-2xl border border-line bg-overlay p-3">
                    <img src={githubUser.avatar_url} alt={githubUser.login} className="w-9 h-9 rounded-full" />
                    <div className="min-w-0">
                      <div className="text-xs text-ink font-medium truncate">{githubUser.name}</div>
                      <div className="text-[11px] text-ink-4">@{githubUser.login}</div>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-[11px] uppercase tracking-wider text-ink-4">Push Workspace</h3>
                    <div className="mt-2 space-y-2">
                      <select
                        value={targetRepo}
                        onChange={(event) => setTargetRepo(event.target.value)}
                        className="w-full cursor-pointer rounded-xl border border-line bg-overlay px-3 py-2 text-xs text-ink-2 outline-none transition-colors focus:border-accent-line"
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
                          className="min-w-0 flex-1 rounded-xl border border-line bg-overlay px-3 py-2 text-xs text-ink-2 outline-none transition-colors focus:border-accent-line"
                        />
                        <button
                          type="button"
                          onClick={() => void handleWriteCommitMessage()}
                          disabled={isWritingCommitMessage || workspaceFiles.length === 0}
                          title="Write a commit message from the current git diff (or unsaved files)"
                          className="flex shrink-0 items-center gap-1 rounded-xl border border-accent-line bg-accent-soft px-2.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40 cursor-pointer"
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
                        className="w-full rounded-xl bg-accent-strong py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
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
              <section className="space-y-1.5 rounded-2xl border border-accent-line bg-accent-soft p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-accent">
                  <ShieldCheck className="w-4 h-4 text-accent" />
                  ShadRox Secure Secrets Vault (Zero Disk Footprint)
                </div>
                <p className="text-[11px] text-ink-3 leading-relaxed">
                  No <code className="text-accent font-mono">.env</code> file is written to your disk or workspace. All secrets are kept only in this app session's memory — never encrypted to disk, never persisted — and injected directly into your active runtime and bundler (<code className="text-accent font-mono">process.env</code> and <code className="text-accent font-mono">import.meta.env</code>).
                </p>
              </section>

              {/* Where a secret actually goes — the honest scope, not a blank panel. */}
              <section className="rounded-2xl border border-line bg-overlay p-3">
                <h3 className="text-[11px] uppercase tracking-wider text-ink-4">Where a secret goes</h3>
                <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-ink-3">
                  <li className="flex gap-2">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                    <span>Injected into the in-app preview bundle as <code className="font-mono text-accent">process.env</code> / <code className="font-mono text-accent">import.meta.env</code>.</span>
                  </li>
                  <li className="flex gap-2">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                    <span>Their names (never values) are listed to the model so it can write code that reads them.</span>
                  </li>
                  <li className="flex gap-2">
                    <X className="mt-0.5 h-3 w-3 shrink-0 text-ink-5" />
                    <span>Not written to <code className="font-mono">.env</code>, not sent to GitHub push, and not passed to the terminal — restarting ShadRox clears the vault.</span>
                  </li>
                </ul>
              </section>
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-ink-4 flex items-center gap-1.5">
                  <Lock className="w-3 h-3" />
                  Add Environment Secret
                </h3>
                <div className="mt-2 flex gap-2">
                  <input
                    value={newSecretKey}
                    onChange={(event) => setNewSecretKey(event.target.value.toUpperCase())}
                    placeholder="VARIABLE_NAME"
                    className="w-2/5 rounded-xl border border-line bg-overlay px-3 py-2 text-xs font-mono text-ink outline-none transition-colors placeholder:text-ink-5 focus:border-accent-line"
                  />
                  <input
                    value={newSecretValue}
                    onChange={(event) => setNewSecretValue(event.target.value)}
                    placeholder="Secret value"
                    className="flex-1 min-w-0 rounded-xl border border-line bg-overlay px-3 py-2 text-xs font-mono text-ink outline-none transition-colors placeholder:text-ink-5 focus:border-accent-line"
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
                    className="rounded-xl bg-accent-strong px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 cursor-pointer"
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
                      className="rounded-md border border-line px-2 py-0.5 text-[10px] font-mono text-ink-3 transition-colors hover:border-accent-line hover:text-accent cursor-pointer"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>

                {/* Secret Items List */}
                <div className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-overlay">
                  {secrets.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-ink-5 italic">No secrets configured in vault.</div>
                  ) : (
                    secrets.map((secret) => (
                      <div key={secret.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="w-2/5 shrink-0 text-[11px] font-mono text-accent truncate">
                          {secret.key}
                        </span>
                        <span className="flex-1 min-w-0 text-[11px] font-mono text-ink-3 truncate">
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
                          className="p-1 text-ink-4 hover:text-ink cursor-pointer"
                        >
                          {secret.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSecretsChange(secrets.filter((item) => item.id !== secret.id))}
                          title="Delete secret"
                          className="p-1 text-ink-4 hover:text-danger cursor-pointer"
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
        </div>
      </aside>
    </div>
  );
}
