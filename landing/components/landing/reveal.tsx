'use client'

import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type RevealProps = {
  children: ReactNode
  /** Delay before the reveal transition starts, in ms. Useful for staggering. */
  delay?: number
  /** Reveal style: slide-up (default) or scale-in. */
  variant?: 'up' | 'scale'
  /** Render as a different element (defaults to div). */
  as?: ElementType
  /** Extra classes for the wrapper. */
  className?: string
  /** Only animate the first time it enters the viewport (default true). */
  once?: boolean
  /** Margin around the root used for the IntersectionObserver rootMargin. */
  rootMargin?: string
}

/**
 * Wraps children and fades/slides them into view using IntersectionObserver.
 * The actual motion is defined in globals.css via `.reveal-item`.
 */
export function Reveal({
  children,
  delay = 0,
  variant = 'up',
  as: Tag = 'div',
  className,
  once = true,
  rootMargin = '0px 0px -10% 0px',
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    // Respect reduced motion: show immediately.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          if (once) observer.disconnect()
        } else if (!once) {
          setVisible(false)
        }
      },
      { rootMargin, threshold: 0.1 },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [once, rootMargin])

  return (
    <Tag
      ref={ref as never}
      className={cn(variant === 'scale' ? 'reveal-scale' : 'reveal-item', visible && 'is-visible', className)}
      style={{ '--reveal-delay': `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </Tag>
  )
}
