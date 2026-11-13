import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getDesktopBridge } from '../../lib/desktop';
import {
  hasAutomationConsent,
  notifyWorkspaceConfigChanged,
  setAutomationConsent
} from '../../lib/workspaceConsent';
import {
  parseAutomations,
  type AutomationAction,
  type AutomationTrigger
} from '../../lib/automations';
import { AutomationWebhookCard } from './AutomationWebhookCard';
import {
  Card,
  Notice,
  SectionTitle,
  StatusBadge,
  errorMessage,
  inputClass,
  primaryButtonClass
} from './shared';

export interface AutomationsSectionProps {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

const AUTOMATIONS_PATH = '.shadrox/automations.json';

const EXAMPLE = JSON.stringify(
  [
    {
      id: 'nightly-todos',
      name: 'Nightly TODO review',
      enabled: true,
      trigger: { type: 'interval', minutes: 1440 },
      action: { type: 'prompt', prompt: 'Review open TODOs and summarize what changed.' },
      creditsPerRun: 1
    },
    {
      id: 'review-on-webhook',
      name: 'Review on webhook',
      enabled: true,
      trigger: { type: 'webhook', path: '/review', secret: 'change-me-0123456789' },
      action: { type: 'prompt', prompt: 'Review the latest changes.' },
      creditsPerRun: 1
    }
  ],
  null,
  2
);

function triggerSummary(trigger: AutomationTrigger): string {
  if (trigger.type === 'interval') return `every ${trigger.minutes} min`;
  if (trigger.type === 'onSave') return `on save · ${trigger.glob}`;
  return `webhook · POST ${trigger.path}`;
}

function actionSummary(action: AutomationAction): string {
  return action.type === 'command' ? `command: ${action.argv}` : `prompt: ${action.prompt}`;
}

export function AutomationsSection({ workspaceId, workspaceRoot }: AutomationsSectionProps) {
  const [text, setText] = useState(EXAMPLE);
  const [loading, setLoading] = useState(true);
  const [loadNote, setLoadNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [consented, setConsented] = useState(() => hasAutomationConsent(workspaceRoot));
  const [savedText, setSavedText] = useState<string | null>(null);

  const parsed = useMemo(() => parseAutomations(text), [text]);
  const savedParsed = useMemo(
    () => savedText === null ? parsed : parseAutomations(savedText),
    [parsed, savedText]
  );

  const warnings = useMemo(() => {
    const seen = new Map<string, string>();
    const found: string[] = [];
    for (const definition of parsed.definitions) {
      if (!definition.enabled || definition.trigger.type !== 'webhook') continue;
      const path = definition.trigger.path;
      const owner = seen.get(path);
      if (owner) {
        found.push(
          `Enabled automations "${owner}" and "${definition.id}" both listen on ${path}; the lower id wins.`
        );
      } else {
        seen.set(path, definition.id);
      }
    }
    return found;
  }, [parsed.definitions]);

  useEffect(() => {
    setConsented(hasAutomationConsent(workspaceRoot));
  }, [workspaceRoot]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadNote(null);
    setSaveError(null);
    setSaved(null);

    const run = async () => {
      const desktop = getDesktopBridge();
      if (!workspaceId || !desktop) {
        if (!cancelled) {
          setText(EXAMPLE);
          setSavedText(null);
          setLoadNote('Open a folder workspace to edit its automations. This example is not saved.');
          setLoading(false);
        }
        return;
      }
      try {
        const file = await desktop.readFile(workspaceId, AUTOMATIONS_PATH);
        if (!cancelled) {
          setText(file.content);
          setSavedText(file.content);
        }
      } catch {
        if (!cancelled) {
          setText(EXAMPLE);
          setSavedText(null);
          setLoadNote('No automations file yet — this example is not saved until you click Save.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const toggleConsent = (next: boolean) => {
    if (!workspaceRoot) return;
    setAutomationConsent(workspaceRoot, next);
    setConsented(next);
    notifyWorkspaceConfigChanged();
  };

  const save = async () => {
    const desktop = getDesktopBridge();
    if (!desktop || !workspaceId) return;
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const files = [{ name: AUTOMATIONS_PATH, content: text, language: 'json' }];
      const result = await desktop.saveFiles(workspaceId, files);
      if (result.errors.length > 0) {
        setSaveError(result.errors.map((entry) => `${entry.name}: ${entry.message}`).join(' '));
      } else {
        setSaved(result.saved.length > 0 ? `Saved ${result.saved.join(', ')}.` : 'Saved to disk.');
        setLoadNote(null);
        setSavedText(text);
        // Saving is the explicit review step; automation runs stay paused
        // until the user opts this workspace in.
        if (workspaceRoot && parsed.errors.length === 0) {
          setAutomationConsent(workspaceRoot, true);
          setConsented(true);
          notifyWorkspaceConfigChanged();
        }
      }
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section>
        <div className="flex items-center justify-between gap-2">
          <SectionTitle>Automations</SectionTitle>
          <span className="truncate font-mono text-[10px] text-neutral-500">{AUTOMATIONS_PATH}</span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
          Edit the JSON directly. Definitions are validated as you type; nothing is written until you click Save.
        </p>
      </section>

      <AutomationWebhookCard
        workspaceId={workspaceId}
        definitions={savedParsed.definitions}
        enabled={consented}
      />

      {!consented ? (
        <Notice tone="info">
          Automations are paused for this workspace. A repository can ship{' '}
          <code className="font-mono text-violet-300">.shadrox/automations.json</code>, but nothing runs until you
          enable it. Saving also enables it.
          <button
            type="button"
            className="ml-2 rounded-md border border-violet-300/30 px-2 py-0.5 text-[10px] text-violet-200 transition-colors hover:bg-violet-500/10"
            onClick={() => toggleConsent(true)}
            disabled={!workspaceRoot}
          >
            Enable automations
          </button>
        </Notice>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-violet-300/20 bg-violet-500/[.06] px-3 py-2">
          <span className="text-[11px] text-violet-200">Automations are enabled for this workspace.</span>
          <button
            type="button"
            className="rounded-md border border-white/[0.09] px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-red-400/40 hover:text-red-300"
            onClick={() => toggleConsent(false)}
          >
            Pause
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading automations...
        </div>
      ) : (
        <>
          <Card className="space-y-2">
            <SectionTitle>Parsed automations ({parsed.definitions.length})</SectionTitle>
            {parsed.definitions.length === 0 ? (
              <p className="text-[11px] text-neutral-500">No valid automations yet.</p>
            ) : (
              <div className="space-y-2">
                {parsed.definitions.map((definition) => (
                  <div
                    key={definition.id}
                    className={`rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 ${
                      definition.enabled ? '' : 'opacity-60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-neutral-200">{definition.name}</span>
                      <StatusBadge enabled={definition.enabled} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-neutral-500">
                      <span className="text-violet-300">{triggerSummary(definition.trigger)}</span>
                      <span className="break-all">{actionSummary(definition.action)}</span>
                      <span
                        title={`One run may not spend more than ${definition.creditsPerRun} units of work on your own key (1 ≈ one edit-sized turn). ShadRox bills nothing; this only stops a runaway run.`}
                      >
                        cap {definition.creditsPerRun}/run
                      </span>
                      {definition.maxRunsPerDay !== undefined && (
                        <span>max {definition.maxRunsPerDay}/day</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-2">
            <SectionTitle>automations.json</SectionTitle>
            <textarea
              rows={16}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(null);
              }}
              spellCheck={false}
              className={`${inputClass} resize-y leading-relaxed`}
            />
            {parsed.errors.length > 0 && (
              <div className="space-y-0.5 rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2">
                {parsed.errors.map((message, index) => (
                  <p
                    key={`${index}-${message}`}
                    className="whitespace-pre-wrap break-words font-mono text-[10px] text-red-400"
                  >
                    {message}
                  </p>
                ))}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="space-y-0.5 rounded-lg border border-amber-500/25 bg-amber-500/[.06] px-3 py-2">
                {warnings.map((warning) => (
                  <p
                    key={warning}
                    className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-amber-300"
                  >
                    {warning}
                  </p>
                ))}
              </div>
            )}
            {loadNote && <Notice tone="info">{loadNote}</Notice>}
            {saveError && <Notice tone="error">{saveError}</Notice>}
            {saved && <Notice tone="ok">{saved}</Notice>}
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[10px] ${
                  parsed.errors.length > 0 ? 'text-red-400' : 'text-violet-300'
                }`}
              >
                {parsed.errors.length > 0
                  ? `${parsed.errors.length} error(s) — fix before saving`
                  : 'JSON is valid.'}
              </span>
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => void save()}
                disabled={saving || !workspaceId || parsed.errors.length > 0}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? 'Saving...' : 'Save automations'}
              </button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
