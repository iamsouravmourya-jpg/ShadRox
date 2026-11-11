import { Navbar } from '@/components/landing/navbar'
import { Hero } from '@/components/landing/hero'
import { Stats } from '@/components/landing/stats'
import { Marquee } from '@/components/landing/marquee'
import { WhatsNew } from '@/components/landing/whats-new'
import { Features } from '@/components/landing/features'
import { HowItWorks } from '@/components/landing/how-it-works'
import { AgentSection } from '@/components/landing/agent-section'
import { WhyNot } from '@/components/landing/why-not'
import { PreviewSupport } from '@/components/landing/preview-support'
import { Privacy } from '@/components/landing/privacy'
import { BetaHonesty } from '@/components/landing/beta-honesty'
import { Faq } from '@/components/landing/faq'
import { BetaCta } from '@/components/landing/beta-cta'
import { Footer } from '@/components/landing/footer'

export default function Page() {
  return (
    <main id="top" className="relative">
      <Navbar />
      <Hero />
      <Stats />
      <Marquee />
      <WhatsNew />
      <Features />
      <HowItWorks />
      <AgentSection />
      <WhyNot />
      <PreviewSupport />
      <Privacy />
      <BetaHonesty />
      <Faq limit={10} />
      <BetaCta />
      <Footer />
    </main>
  )
}