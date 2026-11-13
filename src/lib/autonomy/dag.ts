/**
 * DAG scheduling for work that runs in dependency order.
 *
 * The run-loop owns the while-loop; this file only answers three questions about
 * a node list: what can run next, what can never run, and does the graph contain
 * a cycle. Keeping it here (and pure) means scheduling can be tested without a
 * model, a terminal, or a file.
 *
 * The functions are generic over the node shape on purpose: a milestone and a
 * multi-agent team task carry the same `id`/`dependsOn`/`status`, so one tested
 * scheduler serves both instead of each growing its own copy.
 */

/** The least a node must expose to take part in a dependency graph. */
export interface DependencyNode {
  id: string;
  dependsOn: string[];
}

/** A dependency graph node that is also scheduled, i.e. carries a status. */
export interface SchedulableNode extends DependencyNode {
  status: string;
}

/**
 * A dependency counts as advanced when it passed, or when it finished without
 * anything disproving it (`unverified`). Treating an unverified node as still
 * runnable would stall the whole plan on a milestone that merely had no checker;
 * treating it as `passed` would let one unproven step vouch for everything below
 * it. It advances, and it stays labelled for what it was.
 */
const ADVANCED_STATUSES = new Set(['passed', 'unverified']);

/** A dependency is satisfied only when it exists and has actually advanced. */
export function dependenciesSatisfied<T extends SchedulableNode>(node: T, all: T[]): boolean {
  return node.dependsOn.every((id) => {
    const status = all.find((candidate) => candidate.id === id)?.status;
    return status !== undefined && ADVANCED_STATUSES.has(status);
  });
}

/** True when at least one dependency failed or was itself blocked — this node can never run. */
export function dependenciesUnsatisfiable<T extends SchedulableNode>(node: T, all: T[]): boolean {
  return node.dependsOn.some((id) => {
    const status = all.find((candidate) => candidate.id === id)?.status;
    return status === 'failed' || status === 'blocked';
  });
}

/**
 * The next pending node whose dependencies have all passed, in list order.
 * List order is the tie-break on purpose: a run must replay identically from a
 * persisted state, so scheduling may not depend on anything but the array.
 */
export function nextRunnable<T extends SchedulableNode>(all: T[]): T | null {
  return all.find((node) => node.status === 'pending' && dependenciesSatisfied(node, all)) ?? null;
}

/** Pending nodes that can never run because a dependency failed or was blocked. */
export function findBlocked<T extends SchedulableNode>(all: T[]): T[] {
  return all.filter((node) => node.status === 'pending' && dependenciesUnsatisfiable(node, all));
}

/** Number of nodes still waiting to run. */
export function countPending<T extends SchedulableNode>(all: T[]): number {
  return all.filter((node) => node.status === 'pending').length;
}

/**
 * Ids that take part in a dependency cycle, or an empty array when the graph is
 * acyclic. Every id named in a cycle is returned, so the planner can tell the
 * user the whole knot rather than one arbitrary edge.
 */
export function findCycles<T extends DependencyNode>(all: T[]): string[] {
  const byId = new Map(all.map((node) => [node.id, node]));
  const inCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      // Everything from this id's first appearance in the stack forms the cycle.
      const start = stack.indexOf(id);
      for (const cycleId of stack.slice(start === -1 ? 0 : start)) inCycle.add(cycleId);
      return;
    }
    const node = byId.get(id);
    if (!node) return;
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of node.dependsOn) visit(dependency);
    stack.pop();
    state.set(id, 'done');
  };

  for (const node of all) visit(node.id);
  return [...inCycle];
}
