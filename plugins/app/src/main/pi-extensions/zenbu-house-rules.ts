import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"

/**
 * Inject Zenbu's house rules / plugin-authoring guide into every
 * embedded session's system prompt.
 *
 * The whole point of this app is that the user can modify it at
 * runtime. For that to work, the agent needs to know:
 *
 *   1. This app is a Zenbu.js app.
 *   2. *Where* the Zenbu source lives on this machine (`$ZENBU`).
 *   3. Which docs explain how to author plugins, services, schema,
 *      events, views, etc.
 *
 * We resolve the Zenbu root once (env override → marker-file walk)
 * and hand the agent a stable, absolute path so it can read AGENTS.md
 * and the `context/` docs no matter which project directory the
 * active session is scoped to.
 */

function hasZenbuMarkers(dir: string): boolean {
  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>
    return pkg.name === "zenbu"
  } catch {
    return false
  }
}

function walkUpForRoot(start: string): string | null {
  let current = resolve(start)
  // Walk up to the filesystem root looking for the Zenbu source markers.
  for (;;) {
    if (hasZenbuMarkers(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Resolve the absolute path of the Zenbu source checkout.
 *
 * Order of precedence:
 *   1. `ZENBU_SOURCE_DIR` env var (explicit override; also used by
 *      `PlaygroundService` for the same purpose).
 *   2. Walk up from this compiled module's directory.
 *   3. Walk up from the session cwd as a last resort.
 */
function resolveZenbuRoot(cwd: string): string | null {
  const fromEnv = process.env.ZENBU_SOURCE_DIR?.trim()
  if (fromEnv) {
    const found = walkUpForRoot(resolve(fromEnv))
    if (found) return found
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const fromModule = walkUpForRoot(here)
    if (fromModule) return fromModule
  } catch {
    // import.meta.url not a file URL (unusual bundling) — fall through.
  }

  return walkUpForRoot(cwd)
}

function houseRulesPrompt(root: string): string {
  return [
    "# Zenbu app — editing this app",
    "",
    "This app is itself a **Zenbu.js** app, and the user can modify it at",
    "runtime. When the user asks you to change, extend, or build features",
    "for the app (new sidebars, views, panes, services, slash commands,",
    "plugins, etc.), treat the Zenbu source checkout as your project.",
    "",
    `The Zenbu source lives at (call this \`$ZENBU\`):`,
    "",
    `    ${root}`,
    "",
    "Before doing any app work, read the house rules and framework docs:",
    "",
    `- \`$ZENBU/AGENTS.md\` — start here: house rules + plugin authoring guide.`,
    `- \`$ZENBU/context/rules/AGENTS.md\` — house rules in detail.`,
    `- \`$ZENBU/context/zenbujs/\` — framework reference, one file per topic`,
    "  (services, rpc, events, database/migrations, plugins, injections,",
    "  advice, views, production).",
    "",
    "Monorepo layout:",
    "",
    `- \`$ZENBU/plugins/*\` — actual Zenbu plugins. Each has a`,
    "  `zenbu.plugin.ts` and ships views/services/schema. To add a feature",
    "  to the app, you almost always create or edit a plugin here.",
    `- \`$ZENBU/packages/*\` — plain npm-style libraries plugins consume`,
    "  (`@zenbu/ui`, `@zenbu/view-theme`). Shared libs go here.",
    "",
    "Key rules to follow (full detail in AGENTS.md):",
    "",
    "- A plugin extends the app three ways: fill a slot (injection with a",
    "  matching `meta.kind`), emit/subscribe to `events.app.*`, or wrap an",
    "  export with advice.",
    "- The DB section name matches the plugin `name` (camelCase). Never",
    "  write to `db.app.*` from another plugin.",
    "- Run `pnpm run db:generate` after schema changes; migrations go in",
    "  `<plugin>/migrations/`.",
    "- Injection names are global — prefix them with the plugin name.",
    "- `react`, `react-dom`, `@zenbujs/core`, and `@zenbu/ui` are provided",
    "  by the runtime; do not bundle them.",
    "",
    "When unsure how a host capability works, read the matching doc under",
    "`$ZENBU/context/zenbujs/` and the closest existing plugin in",
    "`$ZENBU/plugins/` before writing code.",
  ].join("\n")
}

export function createZenbuHouseRulesExtension(cwd: string): ExtensionFactory {
  return pi => {
    const root = resolveZenbuRoot(cwd)
    if (!root) return

    pi.on("before_agent_start", event => ({
      systemPrompt: `${event.systemPrompt}\n\n${houseRulesPrompt(root)}`,
    }))
  }
}
