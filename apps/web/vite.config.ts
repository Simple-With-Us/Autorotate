import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { sentryVitePlugin } from "@sentry/vite-plugin"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
) as { version: string }

function localGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve a Sentry release for this build.  Precedence: an explicit
 * SENTRY_RELEASE override -> Vercel's VERCEL_GIT_COMMIT_SHA (build + runtime
 * System Environment Variable) -> Coolify-style SOURCE_COMMIT -> GitHub
 * Actions' GITHUB_SHA -> a local `git rev-parse HEAD` (bare dev checkouts) ->
 * the package version alone.  Never throws.
 */
function resolveSentryRelease(): string {
  const sha =
    process.env.SENTRY_RELEASE ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.SOURCE_COMMIT ||
    process.env.GITHUB_SHA ||
    localGitSha();
  return sha ? `autorotate-web@${sha.slice(0, 12)}` : `autorotate-web@${pkg.version}`;
}

// Source-map upload target.  Same Sentry project the browser DSN
// (VITE_SENTRY_DSN / Infisical SENTRY_DSN_WEB) reports events into, so
// uploaded maps actually deobfuscate the stack traces that arrive there.
const sentryOrg = process.env.SENTRY_ORG || "simple-with-us";
const sentryProject = process.env.SENTRY_PROJECT || "autorotate-web";
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryRelease = resolveSentryRelease();

// Exposed to the client bundle as import.meta.env.VITE_SENTRY_RELEASE — Vite
// inlines any VITE_-prefixed process.env var present at build time, so
// setting it here (before Vite reads env) needs no extra `define` wiring.
// `??=` never overrides an operator-set value.
process.env.VITE_SENTRY_RELEASE ??= sentryRelease;

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
    react(),
    // Source-map upload stays completely inert without SENTRY_AUTH_TOKEN —
    // every CI and local build is byte-for-byte unchanged when it is unset,
    // which is the default (CI never sets it; Sentry stays dark in CI).
    ...(sentryAuthToken
      ? [
          sentryVitePlugin({
            org: sentryOrg,
            project: sentryProject,
            authToken: sentryAuthToken,
            url: "https://us.sentry.io/",
            release: { name: sentryRelease },
            sourcemaps: {
              filesToDeleteAfterUpload: ["dist/public/**/*.map"],
            },
          }),
        ]
      : []),
  ],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    // Maps are only ever generated when there is a token present to upload
    // them and then strip them from dist — never ship maps publicly by
    // default (sourcemaps.filesToDeleteAfterUpload above deletes them post-
    // upload; this keeps the no-token path from writing them at all).
    sourcemap: Boolean(sentryAuthToken),
  },
});
