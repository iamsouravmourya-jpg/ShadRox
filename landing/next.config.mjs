/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // Vercel serves landing/out as static files; per-domain canonicals are baked
  // at build time from the project's production URL (see lib/site.ts).
  output: 'export',
  images: {
    unoptimized: true,
  },
}

export default nextConfig
