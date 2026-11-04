import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { ThemeProvider } from '@/components/landing/theme-provider'
import './globals.css'

const SITE_URL = 'https://www.shadrox.cyou'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'ShadRox — Your project, code, AI, and preview in one workspace',
  description: 'A native desktop workspace for local projects with a code editor, Markdown preview, BYOK AI chat, project preview, Git tools, and an integrated terminal.',
  keywords: ['ShadRox', 'AI coding workspace', 'desktop IDE', 'BYOK', 'Electron', 'local-first', 'Sourav Maurya'],
  authors: [{ name: 'Sourav Maurya', url: 'https://github.com/iamsouravmourya-jpg' }],
  creator: 'Sourav Maurya',
  publisher: 'ShadRox',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'ShadRox',
    title: 'ShadRox — Your project, code, AI, and preview in one workspace',
    description: 'A native desktop workspace for local projects with a code editor, Markdown preview, BYOK AI chat, project preview, Git tools, and an integrated terminal.',
    images: [{ url: '/icon-512.png', width: 512, height: 512, alt: 'ShadRox logo' }],
  },
  twitter: {
    card: 'summary',
    title: 'ShadRox — Your project, code, AI, and preview in one workspace',
    description: 'A native desktop workspace for local projects with a code editor, Markdown preview, BYOK AI chat, project preview, Git tools, and an integrated terminal.',
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
      softwareVersion: '0.0.5',
      url: SITE_URL,
      downloadUrl: 'https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-v0.0.5-Setup.exe',
      image: `${SITE_URL}/icon-512.png`,
      author: { '@id': `${SITE_URL}/#sourav-maurya` },
      description: 'A native desktop workspace for local projects with a code editor, Markdown preview, BYOK AI chat, project preview, Git tools, and an integrated terminal.',
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Who is behind ShadRox?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'ShadRox is a solo project built and maintained by Sourav Maurya, a full-stack developer and AI engineer based in Delhi, India.',
          },
        },
        {
          '@type': 'Question',
          name: 'Can I download ShadRox now?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Yes. The Download for Windows button links to the latest beta installer for Windows 10 or 11, 64-bit. Google sign-in is required when you first open the app. Windows may show a SmartScreen warning because the installer is not code-signed.',
          },
        },
        {
          '@type': 'Question',
          name: 'Does ShadRox store my project in the cloud?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No. The desktop workspace opens and edits project files on your computer. There is no ShadRox cloud project sync. When you ask the AI for help, the prompt and the project context you include are sent to the provider you selected.',
          },
        },
        {
          '@type': 'Question',
          name: 'Which AI providers are supported?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'The current app supports Gemini, Groq, and custom OpenAI-compatible endpoints, including compatible local gateways. Model availability and limits depend on your provider account.',
          },
        },
      ],
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
