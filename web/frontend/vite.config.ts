import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { execSync } from "child_process"

const commitSha = execSync("git rev-parse --short HEAD").toString().trim()

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  define: {
    __COMMIT_SHA__: JSON.stringify(commitSha),
  },
})
