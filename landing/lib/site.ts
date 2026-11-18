export const SITE_URL_CYOU = 'https://www.shadrox.cyou'
export const SITE_URL_TECH = 'https://www.shadrox.tech'

/**
 * Static export bakes one canonical per build, and each domain is its own
 * Vercel project: VERCEL_PROJECT_PRODUCTION_URL (or an explicit
 * NEXT_PUBLIC_SITE_URL) pins a build to its domain so both stay indexed.
 * Local and unknown builds default to the primary domain.
 */
function resolveSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || ''
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':')[0]
  if (host === 'shadrox.tech' || host.endsWith('.shadrox.tech')) return SITE_URL_TECH
  return SITE_URL_CYOU
}

export const SITE_URL = resolveSiteUrl()