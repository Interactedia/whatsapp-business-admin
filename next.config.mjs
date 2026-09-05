/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep hot-reload output away from the production bundle. Sharing one
  // directory allows a running dev server to overwrite middleware chunks
  // after `next build`, which makes Node load a browser chunk (`self`).
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next-prod",
  reactStrictMode: true,
  // Media is streamed through an authenticated route, so no remote image config needed.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
