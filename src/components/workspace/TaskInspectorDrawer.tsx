import { X } from 'lucide-react';
import { TaskInspector } from '../TaskInspector';
import type { useAcceptance } from '../../hooks/useAcceptance';
import type { useCapsules } from '../../hooks/useCapsules';
import type { useIntentGraph } from '../../hooks/useIntentGraph';
import type { AcceptanceContract, BehaviorEvent } from '../../lib/behavior/types';
import type { RankedModel } from '../../lib/calibratedAuto/router';
import type { CalibratedTaskType, OutcomeRecord, RouteProfile } from '../../lib/calibratedAuto/types';
import type { DecisionInput } from '../../lib/intent/types';

export interface TaskInspectorDrawerProps {
  workspaceRootPath: string | null;
  capsules: ReturnType<typeof useCapsules>;
  intent: ReturnType<typeof useIntentGraph>;
  acceptance: ReturnType<typeof useAcceptance>;
  previewReady: boolean;
  behaviorEvents: BehaviorEvent[];
  behaviorContract: AcceptanceContract | null;
  calibratedOutcomes: OutcomeRecord[];
  calibratedProfiles: RouteProfile[];
  calibratedTaskType: CalibratedTaskType;
  calibratedRanking: RankedModel[];
  onClose: () => void;
  onReplayCapsule: (id: string) => void;
  onRevertCapsule: (id: string) => void;
  onExportCapsules: () => void;
  onImportCapsules: (data: unknown) => void;
  onAddDecision: (input: DecisionInput) => void;
  onExportIntent: () => void;
  onImportIntent: (data: unknown) => void;
  onClearBehavior: () => void;
  onGenerateContract: () => void;
  onRunCheck: (phase: 'baseline' | 'postPatch') => void;
  onCalibratedTaskType: (taskType: CalibratedTaskType) => void;
  onPinModel: (taskType: CalibratedTaskType, model: string | null) => void;
}

export function TaskInspectorDrawer({
  workspaceRootPath,
  capsules,
  intent,
  acceptance,
  previewReady,
  behaviorEvents,
  behaviorContract,
  calibratedOutcomes,
  calibratedProfiles,
  calibratedTaskType,
  calibratedRanking,
  onClose,
  onReplayCapsule,
  onRevertCapsule,
  onExportCapsules,
  onImportCapsules,
  onAddDecision,
  onExportIntent,
  onImportIntent,
  onClearBehavior,
  onGenerateContract,
  onRunCheck,
  onCalibratedTaskType,
  onPinModel
}: TaskInspectorDrawerProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--scrim)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-line-2 bg-base p-3 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-3">Task Inspector</span>
          <button
            type="button"
            onClick={onClose}
            title="Close task inspector"
            aria-label="Close task inspector"
            className="rounded p-1 text-ink-4 transition-colors hover:text-ink cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <TaskInspector
          workspaceRoot={workspaceRootPath}
          capsules={capsules.capsules}
          loading={capsules.loading}
          onRefresh={() => void capsules.refresh()}
          onReplay={onReplayCapsule}
          onRevert={onRevertCapsule}
          onDelete={(id) => void capsules.remove(id)}
          onExport={onExportCapsules}
          onImport={onImportCapsules}
          intentGraph={intent.graph}
          intentDecisions={intent.decisions}
          intentLoading={intent.loading}
          indexedFiles={intent.indexedFiles}
          onIntentRefresh={() => void intent.refresh()}
          onAddDecision={onAddDecision}
          onDeleteDecision={(id) => void intent.removeDecision(id)}
          onAskDependencies={intent.answer}
          onIntentExport={onExportIntent}
          onIntentImport={onImportIntent}
          behaviorEvents={behaviorEvents}
          contract={behaviorContract}
          onClearBehavior={onClearBehavior}
          onGenerateContract={onGenerateContract}
          onRunCheck={onRunCheck}
          checkPhase={acceptance.busy}
          previewReady={previewReady}
          outcomes={calibratedOutcomes}
          routeProfiles={calibratedProfiles}
          calibratedTaskType={calibratedTaskType}
          onCalibratedTaskType={onCalibratedTaskType}
          modelRanking={calibratedRanking}
          onPinModel={onPinModel}
        />
      </div>
    </div>
  );
}
