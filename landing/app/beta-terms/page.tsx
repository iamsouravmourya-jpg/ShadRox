import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight,
  CheckCircle,
  Download,
  FileText,
  ShieldCheck,
  Terminal,
  UserRound,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, WINDOWS_DOWNLOAD_URL } from '@/lib/download'

export const metadata: Metadata = {
  title: 'ShadRox — Beta Terms of Service',
  description:
    'Terms for the ShadRox Windows beta — acceptable use, AI provider responsibilities, limitations of liability, and beta program conditions.',
  alternates: { canonical: '/beta-terms' },
}

const eyebrow = 'text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]'

const sections: {
  icon: typeof ShieldCheck
  title: string
  content: string[]
}[] = [
  {
    icon: UserRound,
    title: 'Beta Program',
    content: [
      'ShadRox is currently in a closed beta for Windows 10 and 11 (64-bit). By downloading and using the beta, you agree to these terms.',
      'The beta is provided "as-is" and "as-available." We may change, suspend, or discontinue the beta at any time without notice.',
      'Beta features may contain bugs, incomplete functionality, or break without warning. We recommend keeping backups of important work.',
    ],
  },
  {
    icon: CheckCircle,
    title: 'Acceptable Use',
    content: [
      'You may use ShadRox for lawful purposes only. Do not use it to develop, distribute, or deploy malware, illegal content, or anything that violates applicable laws.',
      'Do not attempt to reverse-engineer, decompile, or modify the software except as permitted by law.',
      'Do not use the service to infringe on intellectual property rights, privacy rights, or other legal rights.',
      'You are responsible for your API keys and provider accounts. Keep them secure and do not share them.',
    ],
  },
  {
    icon: Terminal,
    title: 'AI Provider Integration',
    content: [
      'ShadRox connects to AI providers (Gemini, Groq, OpenAI, etc.) based on your configuration. Your use of these providers is governed by their respective terms of service and privacy policies.',
      'Your prompts and project context sent to AI providers are processed under the provider\'s data handling terms. ShadRox does not store this data on our servers.',
      'You are responsible for ensuring your use of AI providers complies with their terms and any applicable regulations.',
      'AI-generated code may contain errors. Always review and test AI-generated output before deploying to production.',
    ],
  },
  {
    icon: FileText,
    title: 'Your Data and Projects',
    content: [
      'ShadRox is local-first. Your project files, API keys, and configuration stay on your computer and are not uploaded to ShadRox servers.',
      'We do not access, store, or transmit your project files or API keys.',
      'You retain all rights to your project code and files. ShadRox does not claim ownership of your work.',
      'You are responsible for backing up your projects. We are not liable for data loss.',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Security and Agent Guardrails',
    content: [
      'ShadRox includes agent guardrails: shell commands require approval, file edits go through review, and destructive operations require confirmation.',
      'These guardrails are designed to help you work safely but are not a substitute for your own judgment. Review all agent actions before approving them.',
      'You are responsible for the security of your local environment and the projects you work on.',
    ],
  },
  {
    icon: FileText,
    title: 'Intellectual Property',
    content: [
      'ShadRox and its features are owned by us or our licensors. The software is protected by copyright, trademark, and other intellectual property laws.',
      'You may not copy, modify, distribute, sell, or lease any part of the software without our written permission.',
      'Third-party libraries and dependencies are subject to their own licenses.',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Limitations of Liability',
    content: [
      'To the maximum extent permitted by law, we are not liable for any indirect, incidental, special, consequential, or punitive damages, including loss of data, profits, or business.',
      'Our total liability for any claims arising from your use of the beta shall not exceed the amount you paid for the beta (which is currently $0).',
      'We do not warrant that the beta will be uninterrupted, error-free, or free of harmful components.',
      'You use the beta at your own risk.',
    ],
  },
  {
    icon: FileText,
    title: 'Changes to Terms',
    content: [
      'We may update these terms at any time. We will notify you of material changes by posting the updated terms on this page or within the app.',
      'Your continued use of the beta after changes constitutes acceptance of the new terms.',
      'If you do not agree to the updated terms, you must stop using the beta.',
    ],
  },
  {
    icon: UserRound,
    title: 'Termination',
    content: [
      'You may stop using the beta at any time. We may suspend or terminate your access if you violate these terms.',
      'Upon termination, you must cease all use of the beta and delete any copies you have made.',
      'Sections that by their nature should survive termination (such as intellectual property and limitations of liability) will survive.',
    ],
  },
]

export default function BetaTermsPage() {
  return (
    <PageShell
      eyebrow="Beta Terms"
      title="Beta Terms"
      accent="of Service."
      sub="Terms for the ShadRox Windows beta. By using the beta, you agree to these terms."
    >
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className={`mb-4 ${eyebrow}`}>Effective date</p>
            <p className="text-sm leading-6 text-[var(--mut)]">
              Last updated: November 2025
            </p>
          </Reveal>

          <div className="mt-12 space-y-12">
            {sections.map(({ icon: Icon, title, content }, i) => (
              <Reveal key={title} delay={i * 80}>
                <div className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <div className="flex-1">
                    <h2 className="mb-4 text-xl font-bold tracking-[-0.02em] text-[var(--ink)]">
                      {title}
                    </h2>
                    <div className="space-y-3">
                      {content.map((paragraph, j) => (
                        <p key={j} className="text-sm leading-7 text-[var(--mut)]">
                          {paragraph}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={120}>
            <div className="mt-16 border-t border-[var(--line)] pt-8">
              <p className="text-sm leading-6 text-[var(--mut)]">
                See our{' '}
                <Link href="/privacy" className="text-[var(--ac)] underline">
                  Privacy Policy
                </Link>{' '}
                for details on how we handle your data.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-8 sm:p-12">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full blur-3xl"
                style={{ background: 'var(--glow)' }}
              />
              <div className="relative flex flex-col gap-9 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-xl">
                  <p className={`mb-4 ${eyebrow}`}>Ready to start?</p>
                  <h2 className="text-balance text-[clamp(24px,3vw,34px)] font-bold leading-[1.14] tracking-[-0.04em] text-[var(--ink)]">
                    Download the{' '}
                    <em className="font-normal italic text-[var(--ac)]">beta.</em>
                  </h2>
                  <p className="mt-4 text-sm leading-7 text-[var(--mut)]">
                    Version {APP_VERSION} for Windows 10 or 11 (64-bit). Free to download.
                  </p>
                </div>

                <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center">
                  <a
                    href={WINDOWS_DOWNLOAD_URL}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-6 py-3 text-sm font-bold text-white shadow-[0_10px_28px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_var(--glow)]"
                  >
                    <Download className="size-4" />
                    Download for Windows
                  </a>
                  <Link
                    href="/privacy"
                    className="group inline-flex items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-6 py-3 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    Read Privacy Policy
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}
