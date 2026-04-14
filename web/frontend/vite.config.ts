import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import tailwindcss from "@tailwindcss/vite"
import { execSync } from "child_process"
import path from "path"

function resolveCommitSha(): string {
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA
  try {
    return execSync("git rev-parse --short HEAD").toString().trim()
  } catch {
    return "dev"
  }
}

const commitSha = resolveCommitSha()

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  define: {
    __COMMIT_SHA__: JSON.stringify(commitSha),
  },
  resolve: {
    alias: {
      "@glua/shared": path.resolve(__dirname, "../shared"),
    },
  },
})
