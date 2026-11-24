import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShadRoxDesktopAPI } from '../lib/desktop';
import { findRuleFiles, MAX_RULE_FILE_BYTES, type RuleSource } from '../lib/rules';
import { findSkillFiles, parseSkill, type Skill } from '../lib/skills';
import { WORKSPACE_CONFIG_EVENT } from '../lib/workspaceConsent';
import { isProjectDocPath, workspaceRelative } from '../lib/appHelpers';

export interface UsePluginAutomationsOptions {
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
}

export function usePluginAutomations({
  desktop,
  nativeWorkspaceId
}: UsePluginAutomationsOptions) {
  const ruleDocsRef = useRef<RuleSource[]>([]);
  const skillDocsRef = useRef<Skill[]>([]);
  const [projectSkills, setProjectSkills] = useState<Skill[]>([]);

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

  useEffect(() => {
    const reload = () => {
      void loadProjectDocs();
    };
    window.addEventListener(WORKSPACE_CONFIG_EVENT, reload);
    return () => window.removeEventListener(WORKSPACE_CONFIG_EVENT, reload);
  }, [loadProjectDocs]);

  const handleFilesSaved = useCallback(
    (paths: string[]) => {
      if (!desktop || !nativeWorkspaceId || paths.length === 0) return;
      const relative = [...new Set(paths.map(workspaceRelative))];
      if (relative.some(isProjectDocPath)) void loadProjectDocs();
    },
    [desktop, nativeWorkspaceId, loadProjectDocs]
  );

  return {
    ruleDocsRef,
    skillDocsRef,
    projectSkills,
    handleFilesSaved
  };
}
