import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import tailwindcss from "@tailwindcss/vite"
import { execSync } from "child_process"

const commitSha = execSync("git rev-parse --short HEAD").toString().trim()

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  define: {
    __COMMIT_SHA__: JSON.stringify(commitSha),
  },
})
