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
