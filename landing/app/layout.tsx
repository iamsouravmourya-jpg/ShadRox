import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'

const SITE_URL = 'https://www.shadrox.cyou'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'ShadRox | Your desktop coding workspace',
  description: 'A desktop workspace for your local projects, code editor, Gemini and Groq AI chat, live web previews, and terminal.',
  keywords: ['ShadRox', 'AI coding workspace', 'desktop IDE', 'BYOK', 'Electron', 'local-first', 'Sourav Maurya'],
  authors: [{ name: 'Sourav Maurya', url: 'https://github.com/iamsouravmourya-jpg' }],
  creator: 'Sourav Maurya',
  publisher: 'ShadRox',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'ShadRox',
    title: 'ShadRox | Your desktop coding workspace',
    description: 'Your project, code, AI, and preview — in one workspace. A free Windows beta built solo by Sourav Maurya, a 19-year-old developer and AI engineer from Delhi, India.',
    images: [{ url: '/icon-512.png', width: 512, height: 512, alt: 'ShadRox logo' }],
  },
  twitter: {
    card: 'summary',
    title: 'ShadRox | Your desktop coding workspace',
    description: 'Your project, code, AI, and preview — in one workspace. Free Windows beta.',
    images: ['/icon-512.png'],
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
  colorScheme: 'dark',
  themeColor: '#090a0d',
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
      sameAs: ['https://github.com/iamsouravmourya-jpg'],
      jobTitle: 'Solo Developer & AI Engineer',
      description: 'A 19-year-old full-stack developer and AI engineer from Delhi, India. Built ShadRox alone.',
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
      softwareVersion: '0.0.5',
      url: SITE_URL,
      downloadUrl: 'https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-v0.0.5-Setup.exe',
      image: `${SITE_URL}/icon-512.png`,
      author: { '@id': `${SITE_URL}/#sourav-maurya` },
      description: 'Native desktop workspace with a local code editor, BYOK AI chat, agent tools, live web previews, Git tools, and terminal.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
    },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
