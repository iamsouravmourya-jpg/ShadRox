/**
 * Shared local Concept-to-Code Synonym Graph.
 *
 * Single source of truth consumed by BOTH `semanticIndex.ts` (BM25 query
 * expansion) and `agent/repoMap.ts` (OryTree product-domain classification).
 * Pure, dependency-free, 100% local — zero network calls and zero duplicate
 * synonym tables.
 */

export type ConceptClusterId = 'auth' | 'billing' | 'db' | 'api' | 'ui';

export const CONCEPT_SYNONYM_CLUSTERS: Readonly<Record<ConceptClusterId, readonly string[]>> = {
  auth: [
    'login',
    'auth',
    'signin',
    'signup',
    'logout',
    'session',
    'token',
    'jwt',
    'cookie',
    'credential',
    'credentials',
    'guard',
    'gatekeeper',
    'oauth',
    'permission',
    'permissions',
    'rbac',
    'password',
    'passport',
    'acl'
  ],
  billing: [
    'payment',
    'payments',
    'billing',
    'pricing',
    'price',
    'stripe',
    'razorpay',
    'ledger',
    'quota',
    'subscription',
    'subscriptions',
    'webhook',
    'checkout',
    'invoice',
    'invoices',
    'refund',
    'plan',
    'plans',
    'credit',
    'credits'
  ],
  db: [
    'db',
    'database',
    'prisma',
    'drizzle',
    'schema',
    'migration',
    'migrations',
    'query',
    'queries',
    'repository',
    'repositories',
    'model',
    'models',
    'sql',
    'sqlite',
    'postgres',
    'postgresql',
    'mongoose',
    'typeorm',
    'knex',
    'table',
    'tables'
  ],
  api: [
    'api',
    'server',
    'backend',
    'route',
    'routes',
    'router',
    'routers',
    'controller',
    'controllers',
    'handler',
    'handlers',
    'middleware',
    'endpoint',
    'endpoints',
    'graphql',
    'trpc',
    'resolver',
    'resolvers',
    'worker',
    'workers'
  ],
  ui: [
    'ui',
    'component',
    'components',
    'page',
    'pages',
    'layout',
    'modal',
    'dialog',
    'drawer',
    'toast',
    'banner',
    'navbar',
    'sidebar',
    'header',
    'footer',
    'dashboard',
    'settings',
    'profile',
    'landing',
    'hero',
    'form',
    'button',
    'table',
    'chart'
  ]
};

const tokenToClusters = new Map<string, ConceptClusterId[]>();
for (const [clusterId, terms] of Object.entries(CONCEPT_SYNONYM_CLUSTERS) as Array<[ConceptClusterId, readonly string[]]>) {
  for (const term of terms) {
    const existing = tokenToClusters.get(term);
    if (existing) {
      if (!existing.includes(clusterId)) existing.push(clusterId);
    } else {
      tokenToClusters.set(term, [clusterId]);
    }
  }
}

export interface ExpandedConceptTokens {
  exact: string[];
  synonyms: string[];
}

/**
 * Expand normalized lowercase tokens with concept siblings from matching
 * clusters, excluding exact input tokens so exact matches can outrank pure
 * synonym hits.
 */
export function expandConceptTokens(tokens: readonly string[]): ExpandedConceptTokens {
  const exact: string[] = [];
  const exactSet = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (!token || exactSet.has(token)) continue;
    exactSet.add(token);
    exact.push(token);
  }
  const synonymSet = new Set<string>();
  for (const token of exact) {
    const clusters = tokenToClusters.get(token);
    if (!clusters) continue;
    for (const cluster of clusters) {
      for (const sibling of CONCEPT_SYNONYM_CLUSTERS[cluster]) {
        if (!exactSet.has(sibling)) synonymSet.add(sibling);
      }
    }
  }
  return { exact, synonyms: [...synonymSet] };
}

/** Split camelCase / snake_case / path strings into normalized lowercase concept tokens. */
export function splitConceptWords(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const words = spaced.toLowerCase().match(/[a-z0-9]+/g);
  return words ?? [];
}

/**
 * Count how many distinct terms in `text` belong to any of the given concept
 * clusters. Used by OryTree domain classification to recognize hidden names
 * like `session_gatekeeper` (`auth`) or `razorpay_ledger` (`billing`).
 */
export function countConceptClusterHits(text: string, clusters: readonly ConceptClusterId[]): number {
  const allowed = new Set<ConceptClusterId>(clusters);
  const words = new Set(splitConceptWords(text));
  let hits = 0;
  for (const word of words) {
    const memberOf = tokenToClusters.get(word);
    if (!memberOf) continue;
    if (memberOf.some((cluster) => allowed.has(cluster))) hits += 1;
  }
  return hits;
}
