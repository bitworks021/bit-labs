import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/compile": "http://localhost:3001",
      "/ports": "http://localhost:3001",
      "/upload": "http://localhost:3001",
      "/libraries": "http://localhost:3001",
      "/monitor": "http://localhost:3001",
      "/boards": "http://localhost:3001",
      "/cores": "http://localhost:3001",
    },
  },
});
