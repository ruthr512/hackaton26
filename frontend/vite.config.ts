import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: { proxy: { "/api": "http://localhost:8000" } },
  // `vite preview` serves dist/ on Render and proxies /api to the backend (API_TARGET).
  preview: {
    host: true,
    allowedHosts: true,
    proxy: { "/api": { target: process.env.API_TARGET ?? "http://localhost:8000", changeOrigin: true } },
  },
});
