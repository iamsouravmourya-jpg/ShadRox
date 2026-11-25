import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { ThemeProvider } from '@/components/landing/theme-provider'
import { APP_VERSION } from '@/lib/download'
import { SITE_URL, SITE_URL_CYOU, SITE_URL_TECH } from '@/lib/site'
import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
  fallback: ['Segoe UI', 'system-ui', 'sans-serif'],
})

const TITLE = 'ShadRox — Project files, editor, autonomous AI agent, preview, Git and terminals in one app'
const DESCRIPTION = 'A native Windows workspace for local projects: CodeMirror 6 editor, a unified auto-routed AI agent, live preview with console forwarding, Git Push/Pull/Sync, parallel terminals and 1-click checkpoints. Files stay on your computer.'
const OG_DESCRIPTION = 'A native Windows workspace for local projects with a unified BYOK AI agent, live preview, Git sync, and 1-click checkpoints.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  authors: [{ name: 'Sourav Maurya', url: `${SITE_URL}/about` }],
  creator: 'Sourav Maurya',
  publisher: 'ShadRox',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'ShadRox',
    title: TITLE,
    description: OG_DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'ShadRox — project files, editor, AI chat, preview, Git and terminal in one Windows app' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: OG_DESCRIPTION,
    images: ['/og.png'],
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/brand-logo.png', type: 'image/png', sizes: '48x48' },
      { url: '/brand-logo.png', type: 'image/png', sizes: '192x192' },
      { url: '/brand-logo.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: '/brand-logo.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: '#f6f8fb',
}

function buildJsonLd(siteUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${siteUrl}/#organization`,
        name: 'ShadRox',
        url: siteUrl,
        logo: { '@type': 'ImageObject', url: `${siteUrl}/brand-logo.png` },
        foundingDate: '2026',
        founder: { '@id': `${siteUrl}/#sourav-maurya` },
        description: 'ShadRox is a founder-owned, local-first desktop AI coding workspace for Windows.',
        sameAs: [
          'https://www.linkedin.com/company/shadrox',
          SITE_URL_TECH,
          SITE_URL_CYOU,
        ],
      },
      {
        '@type': 'Person',
        '@id': `${siteUrl}/#sourav-maurya`,
        name: 'Sourav Maurya',
        url: `${siteUrl}/about`,
        sameAs: [`${siteUrl}/about`, 'https://www.linkedin.com/in/sourav-maurya-45b272377'],
        jobTitle: 'Founder, Solo Developer & AI Engineer',
        description: 'A full-stack developer and AI engineer from Delhi, India. Founder and owner of ShadRox.',
        address: { '@type': 'PostalAddress', addressLocality: 'Delhi', addressCountry: 'IN' },
      },
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        url: siteUrl,
        name: 'ShadRox',
        publisher: { '@id': `${siteUrl}/#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        name: 'ShadRox',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows 10, Windows 11 (64-bit)',
        softwareVersion: APP_VERSION,
        dateModified: '2026-11-18',
        url: siteUrl,
        downloadUrl: `${siteUrl}/download`,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR', availability: 'https://schema.org/InStock' },
        image: `${siteUrl}/brand-logo.png`,
        author: { '@id': `${siteUrl}/#sourav-maurya` },
        description: 'A native desktop workspace for local projects with a code editor, Markdown preview, BYOK AI chat, project preview, Git tools, and an integrated terminal. Free during beta; bring your own AI provider key.',
      },
    ],
  }
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const jsonLd = buildJsonLd(SITE_URL)

  return (
    <html lang="en" suppressHydrationWarning className={jakarta.variable}>
      <body className="antialiased">
        <a
          href="#top"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-[var(--card)] focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-[var(--ink)] focus:shadow-lg focus:ring-2 focus:ring-[var(--ac)]"
        >
          Skip to content
        </a>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <ThemeProvider>
          {children}
        </ThemeProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}