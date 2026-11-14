import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env["WEB_PORT"] ?? 5173),
    strictPort: true,
    // The API and the context root routes (SPEC-003) are served by the API process.
    proxy: Object.fromEntries(
      ["/api", "/mcp", "/views", "/.well-known"].map((path) => [
        path,
        `http://127.0.0.1:${process.env["PORT"] ?? "3000"}`,
      ]),
    ),
  },
});
