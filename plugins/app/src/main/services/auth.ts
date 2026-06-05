import { shell } from "electron"
import { nanoid } from "nanoid"
import { shellEnv } from "shell-env"

import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"
import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent"
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai"

// ---------------------------------------------------------------------------
// AuthService
//
// Owns the single `AuthStorage` + `ModelRegistry` for the app. All
// reads/writes of credentials flow through pi's own auth file
// (`~/.pi/agent/auth.json`) — we never replicate secrets into the
// renderer-visible db. What we DO publish is:
//
//   - `root.app.providerStatuses` — one entry per known provider
//     describing whether it has auth configured and where the
//     credential is coming from (stored / environment / etc).
//   - `root.app.oauthFlow` — the currently-running OAuth login flow,
//     driven by pi's `AuthStorage.login()` callbacks.
//
// Other services (`SessionsService`) consume `storage` and `registry`
// through `ctx.auth`, so there is exactly one source of truth.
// ---------------------------------------------------------------------------

/**
 * Pi providers we know enough about to render rich UI for.
 *
 * `subscription` → OAuth flow, big "Sign in with X" button.
 * `apiKey`       → plain API-key input.
 * `cloud`        → needs side configuration (account id, region,
 *                  …) beyond a simple key — in v1 we tell the user
 *                  to configure these via env vars / `models.json`.
 *
 * The order here is the display order in the accounts panel. The
 * top three subscription rows are also the buttons we surface in
 * the chat empty-state card.
 */
type ProviderKind = "subscription" | "apiKey" | "cloud"

type ProviderCatalogEntry = {
  id: string
  kind: ProviderKind
  displayName: string
  /** Env var pi will read this provider's key from, when applicable. */
  envVar: string | null
  /** Short tagline shown under the row in settings. */
  tagline: string
  /**
   * Subscription rows whose provider id ALSO accepts a plain
   * API key. True for Anthropic (`anthropic` takes either an
   * OAuth token or `ANTHROPIC_API_KEY`) and GitHub Copilot (a
   * GH PAT works in place of the OAuth token). False for
   * OAuth-only providers like `openai-codex`. The renderer
   * shows a secondary "Use API key instead" affordance on
   * these rows.
   */
  supportsApiKey?: boolean
  /** Hide from the main list (we still publish status for it). */
  hidden?: boolean
}

/**
 * Curated provider catalog. Order matters — this is the visual
 * order in the accounts panel.
 *
 * Promoted (`subscription`) sit at the top: Claude Pro/Max,
 * ChatGPT Plus/Pro Codex, GitHub Copilot — pi's three built-in
 * OAuth providers. These are the "I have an existing AI
 * subscription, log me in" path.
 *
 * Then the most-used API-key providers (anthropic, openai, google,
 * etc.), then everything else, then cloud providers at the bottom
 * with a pointer to `models.json` (v1 doesn't ship cloud-specific
 * forms — Cloudflare account id, AWS profile, etc. live in env
 * vars or `~/.pi/agent/models.json`).
 */
const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // Subscriptions (OAuth). Anthropic and GitHub Copilot ALSO
  // accept an API key under the same provider id — the renderer
  // exposes a "Use API key instead" affordance via
  // `supportsApiKey`.
  {
    id: "anthropic",
    kind: "subscription",
    displayName: "Claude (Pro / Max)",
    envVar: "ANTHROPIC_API_KEY",
    tagline:
      "Sign in with Anthropic, or paste an Anthropic API key. Note: subscription usage bills against Claude extra usage, not your plan.",
    supportsApiKey: true,
  },
  {
    id: "openai-codex",
    kind: "subscription",
    displayName: "ChatGPT (Plus / Pro Codex)",
    envVar: null,
    tagline:
      "Sign in with your ChatGPT account. Officially endorsed by OpenAI for Codex use. OpenAI API keys go in the “OpenAI” row below.",
  },
  {
    id: "github-copilot",
    kind: "subscription",
    displayName: "GitHub Copilot",
    envVar: "GITHUB_TOKEN",
    tagline:
      "Sign in with GitHub, or paste a GitHub token. Enter an Enterprise Server domain when prompted, or leave blank for github.com.",
    supportsApiKey: true,
  },

  // API keys — promoted
  {
    id: "openai",
    kind: "apiKey",
    displayName: "OpenAI",
    envVar: "OPENAI_API_KEY",
    tagline: "API key from platform.openai.com.",
  },
  {
    id: "google",
    kind: "apiKey",
    displayName: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    tagline: "API key from Google AI Studio.",
  },
  {
    id: "xai",
    kind: "apiKey",
    displayName: "xAI",
    envVar: "XAI_API_KEY",
    tagline: "API key from console.x.ai.",
  },
  {
    id: "groq",
    kind: "apiKey",
    displayName: "Groq",
    envVar: "GROQ_API_KEY",
    tagline: "API key from console.groq.com.",
  },
  {
    id: "cerebras",
    kind: "apiKey",
    displayName: "Cerebras",
    envVar: "CEREBRAS_API_KEY",
    tagline: "API key from cloud.cerebras.ai.",
  },
  {
    id: "deepseek",
    kind: "apiKey",
    displayName: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    tagline: "API key from platform.deepseek.com.",
  },
  {
    id: "mistral",
    kind: "apiKey",
    displayName: "Mistral",
    envVar: "MISTRAL_API_KEY",
    tagline: "API key from console.mistral.ai.",
  },
  {
    id: "openrouter",
    kind: "apiKey",
    displayName: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    tagline: "API key from openrouter.ai — route to many providers.",
  },
  {
    id: "vercel-ai-gateway",
    kind: "apiKey",
    displayName: "Vercel AI Gateway",
    envVar: "AI_GATEWAY_API_KEY",
    tagline: "API key from the Vercel AI Gateway dashboard.",
  },
  {
    id: "fireworks",
    kind: "apiKey",
    displayName: "Fireworks",
    envVar: "FIREWORKS_API_KEY",
    tagline: "API key from fireworks.ai.",
  },
  {
    id: "zai",
    kind: "apiKey",
    displayName: "Z.AI",
    envVar: "ZAI_API_KEY",
    tagline: "GLM models via Z.AI.",
  },
  {
    id: "huggingface",
    kind: "apiKey",
    displayName: "Hugging Face",
    envVar: "HF_TOKEN",
    tagline: "Inference Providers via Hugging Face.",
  },
  {
    id: "opencode",
    kind: "apiKey",
    displayName: "OpenCode Zen",
    envVar: "OPENCODE_API_KEY",
    tagline: "OpenCode Zen models.",
  },

  // Cloud — placeholder rows. v1 just points users at the docs.
  {
    id: "azure-openai-responses",
    kind: "cloud",
    displayName: "Azure OpenAI",
    envVar: "AZURE_OPENAI_API_KEY",
    tagline:
      "Configure via `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` env vars.",
  },
  {
    id: "amazon-bedrock",
    kind: "cloud",
    displayName: "Amazon Bedrock",
    envVar: null,
    tagline:
      "Configure via standard AWS env (`AWS_PROFILE`, `AWS_REGION`, etc.).",
  },
  {
    id: "cloudflare-ai-gateway",
    kind: "cloud",
    displayName: "Cloudflare AI Gateway",
    envVar: "CLOUDFLARE_API_KEY",
    tagline:
      "Needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` env vars in addition to the API key.",
  },
  {
    id: "cloudflare-workers-ai",
    kind: "cloud",
    displayName: "Cloudflare Workers AI",
    envVar: "CLOUDFLARE_API_KEY",
    tagline: "Needs `CLOUDFLARE_ACCOUNT_ID` env var in addition to the API key.",
  },
  {
    id: "google-vertex",
    kind: "cloud",
    displayName: "Google Vertex AI",
    envVar: null,
    tagline:
      "Run `gcloud auth application-default login` and set `GOOGLE_CLOUD_PROJECT`.",
  },
]

const CATALOG_BY_ID = new Map(PROVIDER_CATALOG.map(p => [p.id, p] as const))

/** Promoted subscription ids surfaced in the chat empty-state card. */
export const FEATURED_SUBSCRIPTION_IDS: ReadonlyArray<string> = [
  "anthropic",
  "openai-codex",
  "github-copilot",
]

/**
 * Controller for a single in-flight OAuth flow. Pi's
 * `AuthStorage.login()` calls back into us with `onAuth`,
 * `onSelect`, `onPrompt`, `onManualCodeInput` — each callback
 * publishes a step update to the db and (for the ones that need
 * user input) blocks on a deferred promise that an RPC method
 * resolves when the user clicks a button.
 *
 * Only one flow is allowed at a time. Starting a second flow aborts
 * the first via its `AbortController` and clears its pending
 * deferreds so the existing `auth.login()` promise rejects cleanly.
 */
type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type FlowController = {
  flowId: string
  providerId: string
  abortController: AbortController
  /** Resolves the current `onPrompt` / `onSelect` / `onManualCodeInput`. */
  pending: Deferred<string> | null
}

let shellEnvHydrated = false

async function hydrateShellEnv(): Promise<void> {
  if (shellEnvHydrated || process.platform !== "darwin") return
  shellEnvHydrated = true
  try {
    const env = await shellEnv()
    process.env = {
      ...env,
      ...process.env,
      PATH: env.PATH ?? process.env.PATH,
    }
  } catch (err) {
    console.warn("[auth] shell env hydration failed:", err)
  }
}

export class AuthService extends Service.create({
  key: "auth",
  deps: { db: DbService },
}) {
  /** Pi's credential store, backed by `~/.pi/agent/auth.json`. */
  readonly storage = AuthStorage.create()
  /**
   * Pi's model registry. Reads `~/.pi/agent/models.json` for custom
   * providers; resolves keys through `storage`. Other services
   * (`SessionsService`) pull this directly to pass into
   * `createAgentSession`.
   */
  readonly registry = ModelRegistry.create(this.storage)

  /** In-flight flow, or null when idle. */
  private flow: FlowController | null = null

  async evaluate() {
    await hydrateShellEnv()

    // Surface any deferred errors pi's auth layer accumulated
    // during boot (e.g. malformed `auth.json`). They go to the
    // main-process console; the renderer surfaces "not configured"
    // as a normal state.
    for (const err of this.storage.drainErrors()) {
      console.error("[auth] storage error:", err)
    }
    await this.publishStatuses()

    this.setup("clear-flow-on-dispose", () => () => {
      if (this.flow) {
        this.flow.abortController.abort()
        this.flow.pending?.reject(new Error("Auth service disposed"))
        this.flow = null
      }
      void this.ctx.db.client.update(root => {
        root.app.oauthFlow = null
      })
    })
  }

  // ---------------------------------------------------------------------
  // Status publishing
  // ---------------------------------------------------------------------

  /**
   * Walk every provider we know about — every entry in the static
   * catalog plus every OAuth provider pi has registered (covers
   * extension-contributed providers) — and rebuild
   * `root.app.providerStatuses` from `storage.getAuthStatus()`.
   *
   * Also called by `SessionsService` after `refreshAvailableModels`
   * so the renderer's "is this provider connected?" UI stays in
   * lockstep with the model picker.
   */
  async publishStatuses(): Promise<void> {
    // Refresh the registry so models.json changes (and any
    // models.json-backed API keys) take effect on next read.
    this.registry.refresh()

    // Project the now-available model catalog into `root.app.models`
    // alongside `providerStatuses`. Both records have to land in the
    // same `update()` so the renderer's chat empty-state card (which
    // gates on `models` being empty) flips in lockstep with the
    // accounts panel (which gates on `providerStatuses`). Splitting
    // these into two writes would briefly show "connected" in the
    // panel while the composer still shows the sign-in card.
    const available = this.registry.getAvailable()
    const nextModels: Record<
      string,
      {
        provider: string
        id: string
        name: string
        api: string
        reasoning: boolean
        thinkingLevelMap: Record<string, string | null> | null
        input: string[]
        contextWindow: number
        maxTokens: number
      }
    > = {}
    for (const m of available) {
      const key = `${m.provider}/${m.id}`
      let thinkingLevelMap: Record<string, string | null> | null = null
      if (m.thinkingLevelMap) {
        const map: Record<string, string | null> = {}
        for (const [level, value] of Object.entries(m.thinkingLevelMap)) {
          if (value === undefined) continue
          map[level] = value
        }
        thinkingLevelMap = map
      }
      nextModels[key] = {
        provider: m.provider,
        id: m.id,
        name: m.name,
        api: m.api,
        reasoning: m.reasoning,
        thinkingLevelMap,
        input: [...m.input],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      }
    }

    const oauthIds = new Set(
      this.storage.getOAuthProviders().map(p => p.id),
    )
    const ids = new Set<string>([
      ...PROVIDER_CATALOG.map(p => p.id),
      ...oauthIds,
    ])
    const next: Record<
      string,
      {
        id: string
        kind: ProviderKind
        displayName: string
        configured: boolean
        source: AuthSource | null
        label: string | null
        credentialType: "oauth" | "api_key" | null
        envVar: string | null
        supportsApiKey: boolean
      }
    > = {}
    for (const id of ids) {
      const catalog = CATALOG_BY_ID.get(id)
      // Anything OAuth-registered that isn't in our catalog gets a
      // default subscription treatment so extension-contributed
      // providers still show up as a real row.
      const kind: ProviderKind =
        catalog?.kind ?? (oauthIds.has(id) ? "subscription" : "apiKey")
      const displayName =
        catalog?.displayName ?? this.registry.getProviderDisplayName(id)
      const envVar = catalog?.envVar ?? null
      const status = this.storage.getAuthStatus(id)

      // When source === "stored", inspect the on-disk record so
      // the UI can tell "Connected (OAuth)" from "Connected (API
      // key)" — they map to the same provider id for Anthropic
      // and GH Copilot, and the difference matters when the user
      // wants to switch between the two paths. We deliberately
      // only read the `type` discriminator here; the credential
      // value itself never leaves the main process.
      let credentialType: "oauth" | "api_key" | null = null
      if (status.source === "stored") {
        const credential = this.storage.get(id)
        credentialType = credential?.type ?? null
      }

      // OAuth-only catalog entries (no `supportsApiKey`) fall back
      // to whether pi knows an env var for the provider. Extension-
      // contributed providers default to apiKey-supporting unless
      // they explicitly opt out via the catalog.
      const supportsApiKey =
        catalog?.supportsApiKey ??
        (kind !== "subscription" || envVar != null)

      next[id] = {
        id,
        kind,
        displayName,
        configured: status.configured,
        source: (status.source as AuthSource | undefined) ?? null,
        label: status.label ?? null,
        credentialType,
        envVar,
        supportsApiKey,
      }
    }
    await this.ctx.db.client.update(root => {
      root.app.providerStatuses = next
      root.app.models = nextModels
    })
  }

  // ---------------------------------------------------------------------
  // RPC: catalog + status reads
  // ---------------------------------------------------------------------

  /**
   * Returns the static catalog so the renderer can render the
   * accounts panel without hard-coding provider lists. Status
   * lives in `root.app.providerStatuses`.
   */
  listCatalog(): ProviderCatalogEntry[] {
    return PROVIDER_CATALOG.slice()
  }

  // ---------------------------------------------------------------------
  // RPC: API-key mutations
  // ---------------------------------------------------------------------

  /**
   * Persist an API key for `providerId`. Empty / whitespace-only
   * `key` is treated as a "remove" so the textbox can double as a
   * disconnect affordance.
   */
  async setApiKey(args: { providerId: string; key: string }): Promise<void> {
    const trimmed = args.key.trim()
    if (!trimmed) {
      this.storage.remove(args.providerId)
    } else {
      this.storage.set(args.providerId, { type: "api_key", key: trimmed })
    }
    await this.publishStatuses()
  }

  /**
   * Remove the stored credential for `providerId` (works for both
   * stored API keys and OAuth tokens). Env-var-provided credentials
   * remain — they're not ours to remove.
   */
  async removeAuth(args: { providerId: string }): Promise<void> {
    this.storage.remove(args.providerId)
    await this.publishStatuses()
  }

  // ---------------------------------------------------------------------
  // RPC: OAuth flow
  // ---------------------------------------------------------------------

  /**
   * Start an OAuth login flow. Cancels any existing flow first.
   *
   * Returns the new flow id so the caller can match RPC callbacks
   * against it — but the renderer normally reads `root.app.oauthFlow`
   * directly, which has the same id under `flowId`.
   */
  async startOAuthLogin(args: {
    providerId: string
  }): Promise<{ flowId: string }> {
    // Cancel any existing flow first — only one at a time.
    if (this.flow) {
      this.flow.abortController.abort()
      this.flow.pending?.reject(new Error("Superseded by a new login flow"))
      this.flow = null
    }

    const providerId = args.providerId
    const oauthProvider = this.storage
      .getOAuthProviders()
      .find(p => p.id === providerId)
    if (!oauthProvider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`)
    }

    const catalog = CATALOG_BY_ID.get(providerId)
    const displayName = catalog?.displayName ?? oauthProvider.name

    const flowId = nanoid()
    const abortController = new AbortController()
    const flow: FlowController = {
      flowId,
      providerId,
      abortController,
      pending: null,
    }
    this.flow = flow

    // Initial state — modal pops to "starting" immediately, before
    // pi makes its first callback. This gives the user feedback
    // that the click was received even if the browser takes a
    // moment to open.
    await this.ctx.db.client.update(root => {
      root.app.oauthFlow = {
        flowId,
        providerId,
        displayName,
        step: "starting",
        url: null,
        instructions: null,
        selectMessage: null,
        selectOptions: [],
        promptMessage: null,
        promptPlaceholder: null,
        promptAllowEmpty: false,
        supportsManualCode: oauthProvider.usesCallbackServer ?? false,
        progress: [],
        errorMessage: null,
        startedAt: Date.now(),
      }
    })

    const callbacks: OAuthLoginCallbacks = {
      signal: abortController.signal,
      onAuth: info => {
        // Pi gave us a URL to open. Open it in the user's default
        // browser and surface it in the modal so they can re-open
        // it if it gets dismissed.
        void shell.openExternal(info.url).catch(err => {
          console.error("[auth] openExternal failed:", err)
        })
        void this.ctx.db.client.update(root => {
          const f = root.app.oauthFlow
          if (!f || f.flowId !== flowId) return
          f.step = "openUrl"
          f.url = info.url
          f.instructions = info.instructions ?? null
        })
      },
      onDeviceCode: info => {
        // Device-code flow (pi-ai 0.78+): open the verification
        // URL and surface the user code so they can enter it.
        void shell.openExternal(info.verificationUri).catch(err => {
          console.error("[auth] openExternal failed:", err)
        })
        void this.ctx.db.client.update(root => {
          const f = root.app.oauthFlow
          if (!f || f.flowId !== flowId) return
          f.step = "openUrl"
          f.url = info.verificationUri
          f.instructions = `Enter the code: ${info.userCode}`
        })
      },
      onProgress: message => {
        void this.ctx.db.client.update(root => {
          const f = root.app.oauthFlow
          if (!f || f.flowId !== flowId) return
          // Prepend so the latest message is on top — most flows
          // emit a handful of "exchanging code…" / "fetching
          // profile…" steps and only the latest is interesting.
          f.progress = [message, ...f.progress].slice(0, 5)
        })
      },
      onSelect: async prompt => {
        const deferred = makeDeferred<string>()
        flow.pending = deferred
        await this.ctx.db.client.update(root => {
          const f = root.app.oauthFlow
          if (!f || f.flowId !== flowId) return
          f.step = "select"
          f.selectMessage = prompt.message
          f.selectOptions = prompt.options.map(o => ({
            id: o.id,
            label: o.label,
          }))
        })
        const value = await deferred.promise
        // Empty string = user cancelled the select step. Treat
        // exactly like aborting the whole login.
        if (value === "") return undefined
        return value
      },
      onPrompt: async prompt => {
        const deferred = makeDeferred<string>()
        flow.pending = deferred
        await this.ctx.db.client.update(root => {
          const f = root.app.oauthFlow
          if (!f || f.flowId !== flowId) return
          f.step = "prompt"
          f.promptMessage = prompt.message
          f.promptPlaceholder = prompt.placeholder ?? null
          f.promptAllowEmpty = prompt.allowEmpty ?? false
        })
        return await deferred.promise
      },
      onManualCodeInput: async () => {
        const deferred = makeDeferred<string>()
        flow.pending = deferred
        await this.ctx.db.client.update(root => {
          const f = root.app.oauthFlow
          if (!f || f.flowId !== flowId) return
          f.step = "manualCode"
        })
        return await deferred.promise
      },
    }

    // Fire-and-forget — the flow completes asynchronously, and the
    // result is observed via the db record (or via finalize hooks
    // below).
    void this.runLogin(flow, callbacks)

    return { flowId }
  }

  private async runLogin(
    flow: FlowController,
    callbacks: OAuthLoginCallbacks,
  ): Promise<void> {
    try {
      await this.storage.login(flow.providerId, callbacks)
      // Success — clear the flow and refresh statuses so the
      // renderer flips to "Connected" immediately.
      await this.ctx.db.client.update(root => {
        if (root.app.oauthFlow?.flowId === flow.flowId) {
          root.app.oauthFlow = null
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Aborted flows leave a null oauthFlow (the cancel path already
      // cleared it). For everything else, surface the error in the
      // modal so the user can retry.
      if (this.flow?.flowId === flow.flowId) {
        await this.ctx.db.client.update(root => {
          const f = root.app.oauthFlow
          if (!f || f.flowId !== flow.flowId) return
          f.step = "error"
          f.errorMessage = message
        })
      }
    } finally {
      if (this.flow?.flowId === flow.flowId) {
        this.flow = null
      }
      await this.publishStatuses()
    }
  }

  /**
   * Resolve the current `onSelect` step with the chosen option id.
   */
  async selectOAuthOption(args: {
    flowId: string
    optionId: string
  }): Promise<void> {
    const flow = this.flow
    if (!flow || flow.flowId !== args.flowId) return
    const pending = flow.pending
    if (!pending) return
    flow.pending = null
    // Move to a generic "working" state so the user sees feedback
    // while pi runs the next leg of the flow.
    await this.ctx.db.client.update(root => {
      const f = root.app.oauthFlow
      if (!f || f.flowId !== args.flowId) return
      f.step = "completing"
    })
    pending.resolve(args.optionId)
  }

  /**
   * Resolve the current `onPrompt` step with the user's text.
   */
  async submitOAuthPrompt(args: {
    flowId: string
    value: string
  }): Promise<void> {
    const flow = this.flow
    if (!flow || flow.flowId !== args.flowId) return
    const pending = flow.pending
    if (!pending) return
    flow.pending = null
    await this.ctx.db.client.update(root => {
      const f = root.app.oauthFlow
      if (!f || f.flowId !== args.flowId) return
      f.step = "completing"
    })
    pending.resolve(args.value)
  }

  /**
   * Resolve the current `onManualCodeInput` step with the user's
   * pasted code / URL.
   */
  async submitOAuthCode(args: {
    flowId: string
    code: string
  }): Promise<void> {
    const flow = this.flow
    if (!flow || flow.flowId !== args.flowId) return
    const pending = flow.pending
    if (!pending) return
    flow.pending = null
    await this.ctx.db.client.update(root => {
      const f = root.app.oauthFlow
      if (!f || f.flowId !== args.flowId) return
      f.step = "completing"
    })
    pending.resolve(args.code)
  }

  /**
   * User opted into the manual-code paste fallback from the
   * `openUrl` step. We just flip the modal step — pi hasn't called
   * `onManualCodeInput` yet, but the modal can show the textbox
   * and wait for the user to paste. When pi DOES call back, the
   * `pending` deferred gets created and `submitOAuthCode` resolves
   * it.
   *
   * (Pi's built-in OAuth providers call `onManualCodeInput` lazily,
   * after `onAuth` and only when the callback server times out
   * waiting for the redirect. The renderer flow is: user clicks
   * "Paste code instead" → we wait → pi eventually calls back →
   * we expose the textbox. To smooth this out we optimistically
   * show the textbox; the submit RPC no-ops if `pending` isn't
   * ready yet.)
   */
  async requestManualCodeInput(args: { flowId: string }): Promise<void> {
    await this.ctx.db.client.update(root => {
      const f = root.app.oauthFlow
      if (!f || f.flowId !== args.flowId) return
      f.step = "manualCode"
    })
  }

  /**
   * Re-open the OAuth URL in the system browser. Used by the modal's
   * "Open again" button — sometimes the auto-opened tab gets
   * dismissed before the user notices.
   */
  async reopenOAuthUrl(args: { flowId: string }): Promise<void> {
    const flow = this.flow
    if (!flow || flow.flowId !== args.flowId) return
    const url = this.ctx.db.client.readRoot().app.oauthFlow?.url
    if (!url) return
    await shell.openExternal(url).catch(err => {
      console.error("[auth] reopenOAuthUrl failed:", err)
    })
  }

  /**
   * Cancel the in-flight OAuth flow. Aborts pi's internal callback
   * server and rejects any pending deferred so `auth.login()`
   * resolves immediately.
   */
  async cancelOAuthLogin(args: { flowId: string }): Promise<void> {
    const flow = this.flow
    if (!flow || flow.flowId !== args.flowId) return
    flow.abortController.abort()
    flow.pending?.reject(new Error("Cancelled by user"))
    flow.pending = null
    this.flow = null
    await this.ctx.db.client.update(root => {
      if (root.app.oauthFlow?.flowId === args.flowId) {
        root.app.oauthFlow = null
      }
    })
  }

  /**
   * Dismiss a terminal `error` state. The flow is already done at
   * this point — we just clear the modal record so the user can
   * try again.
   */
  async dismissOAuthError(args: { flowId: string }): Promise<void> {
    await this.ctx.db.client.update(root => {
      if (
        root.app.oauthFlow?.flowId === args.flowId &&
        root.app.oauthFlow.step === "error"
      ) {
        root.app.oauthFlow = null
      }
    })
  }
}

type AuthSource =
  | "stored"
  | "runtime"
  | "environment"
  | "fallback"
  | "models_json_key"
  | "models_json_command"
