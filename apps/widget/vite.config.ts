import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
export default defineConfig({
  plugins: [preact()],
  build: {
    target: "es2018",
    lib: { entry: "src/loader.ts", name: "AggreGator", formats: ["iife"], fileName: () => "w.js" },
    minify: "esbuild",
  },
});
