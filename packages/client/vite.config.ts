import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Server URL the dev proxy forwards /api/* to. Override with VITE_API_URL when
// running the client against a different host (e.g. the Pi on the LAN).
const API_URL = process.env.VITE_API_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: API_URL,
        changeOrigin: true,
        // SSE needs a real streaming connection, not a buffered one.
        // Vite's proxy passes this through to http-proxy.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url?.startsWith("/api/stream")) {
              proxyReq.setHeader("Accept", "text/event-stream");
            }
          });
        },
      },
    },
  },
});
