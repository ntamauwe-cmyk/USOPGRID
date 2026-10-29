// Dashboard preview with type-checked fixture data instead of a live backend.
// For visual review only: `npm run preview:fixtures`. Never deploy dist-fixtures.
import path from "path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";
export default defineConfig((env) => mergeConfig(typeof base === "function" ? base(env) : base, {
  resolve: { alias: [
    { find: /^convex\/react$/, replacement: path.resolve(__dirname, "src/__dash/convex-react.tsx") },
    { find: /^@convex-dev\/auth\/react$/, replacement: path.resolve(__dirname, "src/__dash/convex-auth-react.tsx") },
  ] },
  build: { outDir: "dist-fixtures", emptyOutDir: true },
}));
