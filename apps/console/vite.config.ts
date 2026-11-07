import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  plugins: [{ name: "owner-browser-boundary", generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) if (output.type === "chunk") for (const id of Object.keys(output.modules)) {
      if (/\/packages\/(memory|near|owner|storage|inference|crypto|runtime)\//.test(id) || id.startsWith("node:") || id.includes("__vite-browser-external")) {
        this.error("Browser bundle imported a server-only module");
      }
    }
  } }],
});
