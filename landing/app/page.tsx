import { Navbar } from '@/components/landing/navbar'
import { Hero } from '@/components/landing/hero'
import { Marquee } from '@/components/landing/marquee'
import { Features } from '@/components/landing/features'
import { HowItWorks } from '@/components/landing/how-it-works'
import { Privacy } from '@/components/landing/privacy'
import { PreviewSupport } from '@/components/landing/preview-support'
import { Faq } from '@/components/landing/faq'
import { BetaCta } from '@/components/landing/beta-cta'
import { Footer } from '@/components/landing/footer'

export default function Page() {
  return (
    <main id="top" className="min-h-screen overflow-hidden bg-[#090a0d] text-zinc-100">
      <Navbar />
      <Hero />
      <Marquee />
      <Features />
      <HowItWorks />
      <Privacy />
      <PreviewSupport />
      <Faq />
      <BetaCta />
      <Footer />
    </main>
  )
}
