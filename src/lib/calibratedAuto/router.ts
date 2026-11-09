import { listOutcomes, routeProfiles } from './ledger';
import type { CalibratedRoute, CalibratedTaskType, RouteProfile } from './types';

export interface CalibratedRouteChoice {
  route: CalibratedRoute;
  reason: string;
  profile: RouteProfile;
}

export function chooseCalibratedRoute(taskType: CalibratedTaskType, candidates: readonly CalibratedRoute[] = ['reader', 'writer', 'frontier']): CalibratedRouteChoice {
  const profiles = routeProfiles(taskType).filter((profile) => candidates.includes(profile.route));
  const profile = [...profiles].sort((a, b) => b.score - a.score || a.route.localeCompare(b.route))[0] ?? routeProfiles(taskType)[1];
  return {
    route: profile.route,
    profile,
    reason: profile.attempts === 0
      ? 'No verified history yet; using the balanced writer route.'
      : `${Math.round(profile.passRate * 100)}% verified pass rate, ${profile.averageRepairs.toFixed(1)} average repairs across ${profile.attempts} runs.`
  };
}

export function rankModelsByOutcome(taskType: CalibratedTaskType, models: readonly string[]): string[] {
  const outcomes = listOutcomes().filter((record) => record.taskType === taskType);
  const stats = new Map<string, { runs: number; passed: number; repairs: number }>();
  for (const outcome of outcomes) {
    const current = stats.get(outcome.model) ?? { runs: 0, passed: 0, repairs: 0 };
    current.runs += 1;
    current.passed += outcome.passed && outcome.verified ? 1 : 0;
    current.repairs += outcome.repairIterations;
    stats.set(outcome.model, current);
  }
  return [...models].sort((left, right) => {
    const a = stats.get(left);
    const b = stats.get(right);
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const aScore = a.passed / a.runs - a.repairs / (a.runs * 10);
    const bScore = b.passed / b.runs - b.repairs / (b.runs * 10);
    return bScore - aScore;
  });
}
