/**
 * Custom Node server.
 *
 * Hosts the Next.js request handler and a `ws` WebSocket server on the same HTTP
 * port. Webhook + inbox route handlers (running in the same Node process) push
 * realtime events to connected browsers through the shared hub in
 * `src/server/realtime.ts` (kept on globalThis so Next's separate module graph
 * and this server reference the same instance).
 */
import { createServer } from "node:http";
import next from "next";
import { attachRealtime } from "./src/server/realtime";
import { runFlowMaintenance } from "./src/lib/whatsapp/flow-submission";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    // When running behind a tunnel (ngrok, cloudflared, localtunnel) or reverse
    // proxy, the original Host / TLS info is forwarded via these headers.
    // Next.js builds `request.nextUrl` from `req.headers.host`, so we must
    // rewrite the Host header to the public host before handing off. Without
    // this, login redirects, CSRF cookie domains, and callback URLs leak the
    // local listen address (e.g. 0.0.0.0:4020) which the browser cannot
    // resolve through the tunnel.
    const xfHost = req.headers["x-forwarded-host"];
    if (xfHost) {
      req.headers.host = String(xfHost);
    }
    if (!req.headers["x-forwarded-proto"] && req.headers["x-forwarded-host"]) {
      // Infer HTTPS when the request came through a public tunnel.
      req.headers["x-forwarded-proto"] = "https";
    }

    handle(req, res).catch((err) => {
      console.error("Request handler error:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });

  // Attach the WebSocket server for realtime inbox updates.
  attachRealtime(server);

  // Durable Flow webhook retries, launch expiry, and retention cleanup.
  let maintainingFlows = false;
  const maintainFlows = async () => {
    if (maintainingFlows) return;
    maintainingFlows = true;
    try { await runFlowMaintenance(); }
    catch (err) { console.error("Flow maintenance error:", err); }
    finally { maintainingFlows = false; }
  };
  setInterval(maintainFlows, 60_000).unref();
  maintainFlows();

  server.listen(port, hostname, () => {
    console.log(`▶ WhatsApp Business Admin ready on http://${hostname}:${port} (dev=${dev})`);
  });
});
