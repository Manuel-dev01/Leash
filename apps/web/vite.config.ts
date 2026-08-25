import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        delegator: resolve(__dirname, "delegator.html"),
        delegate: resolve(__dirname, "delegate.html"),
      },
    },
  },
});
