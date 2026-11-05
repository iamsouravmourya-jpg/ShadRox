import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { ThemeProvider } from '@/components/landing/theme-provider'
import './globals.css'

const SITE_URL = 'https://www.shadrox.cyou'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'ShadRox — Project files, editor, AI chat, preview, Git and terminal in one Windows app',
  description: 'A native Windows workspace for local projects: focused code editor, bring-your-own-key AI chat, live project preview, Git tools and an integrated terminal. Files stay on your computer; only the context you choose goes to your AI provider.',
  authors: [{ name: 'Sourav Maurya', url: 'https://github.com/iamsouravmourya-jpg' }],
  creator: 'Sourav Maurya',
  publisher: 'ShadRox',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'ShadRox',
    title: 'ShadRox — Project files, editor, AI chat, preview, Git and terminal in one Windows app',
    description: 'A native Windows workspace for local projects. Files stay on your computer; only the context you choose goes to your AI provider.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'ShadRox — project files, editor, AI chat, preview, Git and terminal in one Windows app' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ShadRox — Project files, editor, AI chat, preview, Git and terminal in one Windows app',
    description: 'A native Windows workspace for local projects. Files stay on your computer; only the context you choose goes to your AI provider.',
    images: ['/og.png'],
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon.png', type: 'image/png', sizes: '48x48' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icon-512.png', type: 'image/png', sizes: '512x512' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: '#faf7f5',
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'ShadRox',
      url: SITE_URL,
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon-512.png` },
      foundingDate: '2026',
      founder: { '@id': `${SITE_URL}/#sourav-maurya` },
      description: 'ShadRox is a solo-developed, local-first desktop AI coding workspace for Windows.',
    },
    {
      '@type': 'Person',
      '@id': `${SITE_URL}/#sourav-maurya`,
      name: 'Sourav Maurya',
      url: 'https://github.com/iamsouravmourya-jpg',
      sameAs: ['https://github.com/iamsouravmourya-jpg', 'https://www.linkedin.com/in/sourav-maurya-45b272377', 'https://www.shadrox.cyou'],
      jobTitle: 'Solo Developer & AI Engineer',
      description: 'A full-stack developer and AI engineer from Delhi, India. Built ShadRox alone.',
      address: { '@type': 'PostalAddress', addressLocality: 'Delhi', addressCountry: 'IN' },
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'ShadRox',
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
    {
      '@type': 'SoftwareApplication',
      name: 'ShadRox',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Windows 10, Windows 11 (64-bit)',
      softwareVersion: '0.0.6',
      dateModified: '2026-11-05',
      url: SITE_URL,
      downloadUrl: 'https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-v0.0.6-Setup.exe',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR', availability: 'https://schema.org/InStock' },
      image: `${SITE_URL}/icon-512.png`,
      author: { '@id': `${SITE_URL}/#sourav-maurya` },
      description: 'A native desktop workspace for local projects with a code editor, Markdown preview, BYOK AI chat, project preview, Git tools, and an integrated terminal.',
    },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <ThemeProvider>
          {children}
        </ThemeProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
