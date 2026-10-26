'use client'

import { useEffect, useState } from 'react'

/**
 * Returns true once the page has been scrolled past `threshold` px.
 * Used to toggle the navbar's blurred/bordered state.
 */
export function useScrolled(threshold = 12) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])

  return scrolled
}
