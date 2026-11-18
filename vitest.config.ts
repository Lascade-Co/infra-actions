import { defineConfig } from "vitest/config";

// Plain Node environment. Every network call goes through an injected fetch;
// no test talks to Cloudflare, DigitalOcean, OneUptime, GitHub or Telegram.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
