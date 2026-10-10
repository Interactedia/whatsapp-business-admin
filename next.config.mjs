/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep hot-reload output away from the production bundle. Sharing one
  // directory allows a running dev server to overwrite middleware chunks
  // after `next build`, which makes Node load a browser chunk (`self`).
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next-prod",
  reactStrictMode: true,
  // Media is streamed through an authenticated route, so no remote image config needed.
  typescript: { ignoreBuildErrors: false },
  // Allow common local dev hosts AND any tunneling service (ngrok, cloudflared,
  // localtunnel, etc.) so HMR and asset requests don't get blocked when the
  // user reaches the server through 127.0.0.1, 0.0.0.0, or a public tunnel.
  // For local-only dev, AUTH_TRUST_HOST + AUTH_URL must also be set in .env.
  allowedDevOrigins: [
    "127.0.0.1",
    "0.0.0.0",
    "localhost",
    // Wildcard for *.ngrok-free.app, *.ngrok.app, *.ngrok.io, *.trycloudflare.com, *.loca.lt
    ".ngrok-free.app",
    ".ngrok.app",
    ".ngrok.io",
    ".trycloudflare.com",
    ".loca.lt",
  ],
};

export default nextConfig;
