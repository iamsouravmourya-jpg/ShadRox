import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { commandApprovalNotice } from '../lib/agent/commandGuard';
import {
  consumeBudget,
  dueAutomations,
  evaluateSaveTriggers,
  parseAutomations,
  type AutomationDefinition,
  type AutomationRunRequest,
  type AutomationState
} from '../lib/automations';
import { warnBridgeError } from '../lib/diagnostics';
import type { ShadRoxDesktopAPI } from '../lib/desktop';
import {
  discoverPluginManifests,
  loadPlugins,
  selectHooks,
  type LoadedPlugin,
  type PluginActionRun,
  type PluginLoadEntry
} from '../lib/plugins';
import { findRuleFiles, MAX_RULE_FILE_BYTES, type RuleSource } from '../lib/rules';
import { findSkillFiles, parseSkill, type Skill } from '../lib/skills';
import { hasAutomationConsent, hashPluginManifest, readPluginConsent, WORKSPACE_CONFIG_EVENT } from '../lib/workspaceConsent';
import {
  AUTOMATION_POLL_MS,
  AUTOMATIONS_PATH,
  isPluginManifestPath,
  isProjectDocPath,
  MAX_PLUGIN_COMMANDS_PER_BATCH,
  MAX_PLUGIN_PROMPTS_PER_BATCH,
  MAX_PLUGIN_PROMPT_QUEUE,
  readAutomationStates,
  workspaceRelative,
  writeAutomationStates,
  type AutomationDesktopApi
} from '../lib/appHelpers';

export interface UsePluginAutomationsOptions {
  desktop: ShadRoxDesktopAPI | null;
  desktopBridge: (ShadRoxDesktopAPI & AutomationDesktopApi) | null;
  nativeWorkspaceId: string | null;
  workspaceRootPath: string | null;
  activeKey: string;
  busyRef: MutableRefObject<boolean>;
}

export function usePluginAutomations({
  desktop,
  desktopBridge,
  nativeWorkspaceId,
  workspaceRootPath,
  activeKey,
  busyRef
}: UsePluginAutomationsOptions) {
  const pluginsRef = useRef<LoadedPlugin[]>([]);
  const pluginHooksBusyRef = useRef(false);
  const pendingPromptQueueRef = useRef<string[]>([]);
  const chatHookGuardRef = useRef(false);
  const automationsRef = useRef<AutomationDefinition[]>([]);
  const ruleDocsRef = useRef<RuleSource[]>([]);
  const skillDocsRef = useRef<Skill[]>([]);
  const [projectSkills, setProjectSkills] = useState<Skill[]>([]);
  const automationStatesRef = useRef<Record<string, AutomationState>>({});
  const automationRootRef = useRef<string | null>(null);
  const automationWebhookStartedRef = useRef(false);
  const automationDispatchRef = useRef<((request: AutomationRunRequest) => void) | null>(null);

  // Manifests are data. Loading only fills a ref; every action is later replayed
  // through the normal chat or approval-gated command path.
  const loadWorkspacePlugins = useCallback(async () => {
    if (!desktopBridge?.scanPlugins || !nativeWorkspaceId) {
      pluginsRef.current = [];
      return;
    }
    try {
      const scan = await desktopBridge.scanPlugins(nativeWorkspaceId);
      const entries = new Map(scan.files.map((file) => [workspaceRelative(file.path), file]));
      const manifests = discoverPluginManifests(scan.files.map((file) => file.path));
      const loaded = loadPlugins(
        manifests
          .map((path) => entries.get(workspaceRelative(path)))
          .filter((entry): entry is PluginLoadEntry => Boolean(entry))
          .map((entry) => ({ path: workspaceRelative(entry.path), content: entry.content }))
      );
      // A manifest alone never enables itself; the user opts in per workspace.
      const consent = readPluginConsent(workspaceRootPath);
      pluginsRef.current = await Promise.all(loaded.plugins.map(async (plugin) => {
        const entry = entries.get(workspaceRelative(plugin.sourcePath));
        if (!entry) return { ...plugin, enabled: false };
        const hash = await hashPluginManifest(entry.content);
        return { ...plugin, enabled: consent.get(plugin.manifest.id) === hash };
      }));
    } catch (error) {
      warnBridgeError('plugin-scan', error);
      pluginsRef.current = [];
    }
  }, [desktopBridge, nativeWorkspaceId, workspaceRootPath]);

  useEffect(() => {
    void loadWorkspacePlugins();
  }, [loadWorkspacePlugins]);

  const persistAutomationStates = useCallback(() => {
    const root = automationRootRef.current;
    if (root) writeAutomationStates(root, automationStatesRef.current);
  }, []);

  const stopAutomationWebhookIfRunning = useCallback(() => {
    if (!automationWebhookStartedRef.current) return;
    automationWebhookStartedRef.current = false;
    const stop = desktopBridge?.stopAutomationWebhook;
    if (!stop) return;
    void Promise.resolve(stop()).catch((error) => warnBridgeError('automation-webhook', error));
  }, [desktopBridge]);

  const loadAutomations = useCallback(async () => {
    if (!desktop || !nativeWorkspaceId || !workspaceRootPath) {
      stopAutomationWebhookIfRunning();
      automationsRef.current = [];
      automationStatesRef.current = {};
      automationRootRef.current = null;
      return;
    }
    automationRootRef.current = workspaceRootPath;
    const stored = readAutomationStates(workspaceRootPath);
    if (!hasAutomationConsent(workspaceRootPath)) {
      // The file is visible in Settings, but nothing runs until it is enabled.
      stopAutomationWebhookIfRunning();
      automationsRef.current = [];
      automationStatesRef.current = stored;
      return;
    }
    let raw = '';
    try {
      raw = (await desktop.readFile(nativeWorkspaceId, AUTOMATIONS_PATH)).content;
    } catch {
      automationsRef.current = [];
      automationStatesRef.current = stored;
      return;
    }
    const parsed = parseAutomations(raw);
    automationsRef.current = parsed.definitions;
    const now = Date.now();
    const next: Record<string, AutomationState> = {};
    for (const definition of parsed.definitions) {
      next[definition.id] = stored[definition.id] ?? { id: definition.id, createdAt: now, runCount: 0 };
    }
    automationStatesRef.current = next;
    writeAutomationStates(workspaceRootPath, next);

    const status = desktopBridge?.automationWebhookStatus;
    const start = desktopBridge?.startAutomationWebhook;
    if (parsed.definitions.some((definition) => definition.trigger.type === 'webhook')) {
      if (status && start) {
        try {
          const current = await status(nativeWorkspaceId);
          if (!current.running) await start(nativeWorkspaceId);
          automationWebhookStartedRef.current = true;
        } catch (error) {
          warnBridgeError('automation-webhook', error);
        }
      }
    } else {
      stopAutomationWebhookIfRunning();
    }
  }, [desktop, desktopBridge, nativeWorkspaceId, workspaceRootPath, stopAutomationWebhookIfRunning]);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  /**
   * Project rules and skills live under dot-paths the explorer hides, so they
   * arrive through their own bounded read rather than the file tree. Both are
   * prompt input only: nothing here can write.
   */
  const loadProjectDocs = useCallback(async () => {
    if (!desktop || !nativeWorkspaceId) {
      ruleDocsRef.current = [];
      skillDocsRef.current = [];
      setProjectSkills(skillDocsRef.current);
      return;
    }
    let docs: Array<{ path: string; size: number }>;
    try {
      docs = await desktop.projectDocs(nativeWorkspaceId);
    } catch {
      return;
    }
    const rulePaths = findRuleFiles(docs);
    const skillPaths = findSkillFiles(docs);
    const paths = [...new Set([...rulePaths, ...skillPaths])];
    if (paths.length === 0) {
      ruleDocsRef.current = [];
      skillDocsRef.current = [];
      setProjectSkills(skillDocsRef.current);
      return;
    }
    const read = await desktop
      .loadFiles(nativeWorkspaceId, paths, { maxBytesPerFile: MAX_RULE_FILE_BYTES })
      .catch(() => null);
    const byPath = new Map<string, string>((read?.files ?? []).map((file) => [file.name.replace(/\\/g, '/'), file.content]));
    ruleDocsRef.current = rulePaths.flatMap((path) => {
      const content = byPath.get(path);
      return content === undefined ? [] : [{ path, content }];
    });
    skillDocsRef.current = skillPaths.flatMap((path) => {
      const skill = parseSkill(path, byPath.get(path) ?? '');
      return skill ? [skill] : [];
    });
    setProjectSkills(skillDocsRef.current);
  }, [desktop, nativeWorkspaceId]);

  useEffect(() => {
    void loadProjectDocs();
  }, [loadProjectDocs]);

  // Settings writes config and consent outside the editor's save path, so it
  // announces the change and the running app reloads both engines.
  useEffect(() => {
    const reload = () => {
      void loadWorkspacePlugins();
      void loadAutomations();
      void loadProjectDocs();
    };
    window.addEventListener(WORKSPACE_CONFIG_EVENT, reload);
    return () => window.removeEventListener(WORKSPACE_CONFIG_EVENT, reload);
  }, [loadWorkspacePlugins, loadAutomations, loadProjectDocs]);

  useEffect(() => {
    const stop = desktopBridge?.stopAutomationWebhook;
    if (!stop) return;
    return () => {
      if (!automationWebhookStartedRef.current) return;
      automationWebhookStartedRef.current = false;
      void Promise.resolve(stop()).catch((error) => warnBridgeError('automation-webhook', error));
    };
  }, [desktopBridge, nativeWorkspaceId]);

  const dispatchPluginActionRuns = useCallback(
    (runs: PluginActionRun[]) => {
      // A save can touch many files and a chat turn can match several hooks;
      // the cap keeps a plugin from turning one action into an unbounded run.
      const seenPrompts = new Set<string>();
      let prompts = 0;
      let commands = 0;
      for (const run of runs) {
        if (run.action.type === 'prompt') {
          if (!activeKey) continue;
          if (prompts >= MAX_PLUGIN_PROMPTS_PER_BATCH) continue;
          if (pendingPromptQueueRef.current.length >= MAX_PLUGIN_PROMPT_QUEUE) continue;
          if (seenPrompts.has(run.action.prompt)) continue;
          seenPrompts.add(run.action.prompt);
          prompts += 1;
          pendingPromptQueueRef.current.push(run.action.prompt);
          continue;
        }
        if (!desktop || !nativeWorkspaceId || commands >= MAX_PLUGIN_COMMANDS_PER_BATCH) continue;
        commands += 1;
        void desktop
          .runCommand(nativeWorkspaceId, run.action.argv, commandApprovalNotice(run.action.argv))
          .catch((error) => warnBridgeError('plugin-command', error));
      }
    },
    [activeKey, desktop, nativeWorkspaceId]
  );

  /** Save hooks and save automations both run once per saved path, guarded against re-entry. */
  const handleFilesSaved = useCallback(
    (paths: string[]) => {
      if (!desktop || !nativeWorkspaceId || paths.length === 0) return;
      const relative = [...new Set(paths.map(workspaceRelative))];
      if (relative.some(isPluginManifestPath)) void loadWorkspacePlugins();
      if (relative.includes(AUTOMATIONS_PATH)) void loadAutomations();
      if (relative.some(isProjectDocPath)) void loadProjectDocs();

      if (!pluginHooksBusyRef.current) {
        pluginHooksBusyRef.current = true;
        try {
          const runs = relative.flatMap((path) => selectHooks(pluginsRef.current, 'onSave', { path }));
          dispatchPluginActionRuns(runs);
        } finally {
          pluginHooksBusyRef.current = false;
        }
      }

      for (const path of relative) {
        for (const request of evaluateSaveTriggers(automationsRef.current, path)) {
          automationDispatchRef.current?.(request);
        }
      }
    },
    [desktop, nativeWorkspaceId, loadWorkspacePlugins, loadAutomations, loadProjectDocs, dispatchPluginActionRuns]
  );

  /** Budget-gated dispatch shared by interval, save and webhook triggers. */
  const runAutomationRequest = useCallback(
    (request: AutomationRunRequest) => {
      if (!workspaceRootPath || !desktop || !nativeWorkspaceId) return;
      if (busyRef.current) return;
      if (!activeKey) return;
      const definition = automationsRef.current.find((entry) => entry.id === request.automationId);
      if (!definition || !definition.enabled) return;
      const state = automationStatesRef.current[definition.id] ?? {
        id: definition.id,
        createdAt: Date.now(),
        runCount: 0
      };
      const decision = consumeBudget(state, definition, Date.now());
      if (!decision.allowed) return;
      automationStatesRef.current = { ...automationStatesRef.current, [definition.id]: decision.state };
      persistAutomationStates();

      if (definition.action.type === 'prompt') {
        pendingPromptQueueRef.current.push(definition.action.prompt);
      } else {
        void desktop
          .runCommand(nativeWorkspaceId, definition.action.argv, commandApprovalNotice(definition.action.argv))
          .catch((error) => warnBridgeError('automation-command', error));
      }
    },
    [
      workspaceRootPath,
      desktop,
      nativeWorkspaceId,
      busyRef,
      activeKey,
      persistAutomationStates
    ]
  );

  useEffect(() => {
    automationDispatchRef.current = runAutomationRequest;
  }, [runAutomationRequest]);

  useEffect(() => {
    if (!desktop || !nativeWorkspaceId || !workspaceRootPath) return;
    const tick = () => {
      const now = Date.now();
      for (const request of dueAutomations(automationsRef.current, automationStatesRef.current, now)) {
        runAutomationRequest(request);
      }
    };
    const timer = window.setInterval(tick, AUTOMATION_POLL_MS);
    const first = window.setTimeout(tick, 1_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [desktop, nativeWorkspaceId, workspaceRootPath, runAutomationRequest]);

  useEffect(() => {
    const subscribe = desktopBridge?.onAutomationTrigger;
    if (!subscribe || !nativeWorkspaceId) return;
    return subscribe((event) => {
      if (!event || typeof event.automationId !== 'string') return;
      const definition = automationsRef.current.find((entry) => entry.id === event.automationId);
      if (!definition) return;
      runAutomationRequest({
        automationId: definition.id,
        name: definition.name,
        trigger: 'webhook',
        action: definition.action,
        credits: definition.creditsPerRun,
        reason: 'webhook',
        requestedAt: event.receivedAt
      });
    });
  }, [desktopBridge, nativeWorkspaceId, runAutomationRequest]);

  return {
    pluginsRef,
    ruleDocsRef,
    skillDocsRef,
    projectSkills,
    pendingPromptQueueRef,
    chatHookGuardRef,
    dispatchPluginActionRuns,
    handleFilesSaved
  };
}
