import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env["WEB_PORT"] ?? 5173),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env["PORT"] ?? "3000"}`,
      // Order pages open the approval card view, which the API serves.
      "/views": `http://127.0.0.1:${process.env["PORT"] ?? "3000"}`,
    },
  },
});
