# senpi-accounts — multi-provider addon design

## What stock senpi already does (do NOT reimplement)

Verified against `@code-yeongyu/senpi` 2026.7.29-2 source (`/Users/jgp/GitHub/senpi`).

| Capability | Stock support | Location |
|---|---|---|
| Anthropic subscription via official Claude Agent SDK | yes | `core/extensions/builtin/claude-agent-sdk/` |
| Anthropic multi-account slots | yes | `claude-agent-sdk/accounts.ts` (`AccountSlot`, `listAccounts`, `addAccount`) |
| Anthropic account pin / unpin | yes | `/claude-account pin <name>`, `--claude-account` flag |
| Anthropic 429 → auto failover + timed failback | yes | `claude-agent-sdk/failover.ts` (`blockedUntil`, `retryAfterMs`, exp. backoff capped 48h) |
| Anthropic account affinity (sticky selection) | yes | `claude-agent-sdk/affinity.ts` |
| OpenAI Codex subscription auth | yes | `auth.json` `openai-codex`, `packages/ai/src/api/openai-codex-responses` |
| OpenAI **fast mode** (priority service tier) | yes | `core/extensions/builtin/service-tier.ts` — `-fast` model suffix ⇒ `service_tier: "priority"` |
| Provider-level failover state / usage tracking | yes | `agent/provider-failover-state.json` |
| Extension provider registration | yes | `pi.registerProvider(id, {baseUrl, api, apiKey, models, oauth, streamSimple})` |
| **Kiro provider** | **no** | — addon territory |
| **OpenAI Codex multi-account** | **no** | — addon territory |
| Alibaba Coding Plan | no | addon territory |
| OpenCode Go | no | addon territory |

Consequence for requirement 3 ("keep stock where stock supports it"):
**Anthropic multi-account + rotation + pin + 429 failover is stock. The addon must not
own it.** The addon only surfaces it (doctor/diagnostics) and fills the Kiro / Codex /
Alibaba / OpenCode gaps.

## Layering (requirement 4 & 9)

```
stock senpi (base layer, unmodified)
└── @eddieparc/senpi-accounts        (addon layer, this repo)
    ├── core/                        registration, ownership, isolation, diagnostics
    └── providers/
        ├── kiro/                    isolated package
        ├── codex/                   isolated package
        ├── anthropic/               thin: delegates to stock claude-agent-sdk
        ├── alibaba/                 isolated package
        └── opencode/                isolated package
```

Isolation contract: each provider package is loaded behind its own try/catch and lazy
`import()`. A provider that throws at load, config-parse, or registration time is
recorded as degraded and skipped; every other provider still registers. No provider may
import another provider's module.

## Kiro (requirement 2 — priority)

Auth methods Kiro's service actually supports:
- **Social**: Google, GitHub — via `prod.us-east-1.auth.desktop.kiro.dev`
  (`/login` → PKCE → local callback → `/oauth/token`; refresh via `/refreshToken`).
- **AWS Builder ID / IdC**: SSO OIDC device-code flow via `oidc.<region>.amazonaws.com`
  (`client/register` → `device_authorization` → poll `token`).

AWS Builder ID is *not* served by the Kiro auth service; it must use the device flow.
The pre-existing `src/kiro-oauth.ts` implemented only the device flow, so Google/GitHub
login (what the user actually needs) was unreachable — hence the rebuild.

Inference endpoint: `https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse`
(`X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`,
AWS event-stream response framing, `profileArn` from the token exchange).

Model availability is server-side per subscription tier; the model list is a client-side
catalog and must be reconciled against what the account actually serves.

## Account routing: usage-aware + cache-preserving

Research findings (2026-07-30). The naive reading of requirement 2 is "rotate on
429". That is the *safety net*, not the goal. The expensive resource is not the
quota alone but the **prompt-prefix cache**: switching accounts makes the new
account's cache cold, so a rotation that looks "fair" can cost far more than the
quota it saves.

### What stock senpi already does

`claude-agent-sdk/affinity.ts` selects accounts by **HRW / rendezvous hashing**
keyed on the session id, and its own comment states the intent:

> "Session-stable HRW ordering preserves Claude prompt-cache locality while
> moving only the sessions that rendezvous with a newly added or removed
> account."

So stock **already implements cache-preserving sticky selection** with minimal
disruption on membership change. Stock also has no provider-global selection
state, so sessions do not fight each other.

### What stock does NOT do

No quota-aware placement. Verified by grep across the senpi checkout and its
built `dist`: `usageByProvider`, `exhaustedUntilByProvider` and `stateVersion`
appear **nowhere** in the open-source tree, even though
`~/.senpi/agent/provider-failover-state.json` contains exactly those keys with
live Codex usage (`plan: pro`, `usedPercent: 28`, `resetAt`). That file is
therefore written by a *different, non-public* build. This matches the upstream
author's stated position that the multi-account routing feature is deliberately
not shipped in the public product.

Conclusion: the usage-aware layer is genuinely missing from stock and is real
addon territory. The cache-affinity layer is **not** — do not reimplement it.

### Benchmark: Antigravity-Manager

Its `sticky_config.rs` encodes precisely the tradeoff this addon must expose:

| Mode | Behaviour |
|---|---|
| `CacheFirst` | Lock to one account; on rate limit prefer to *wait* (bounded by `max_wait_seconds`), maximising cache hit rate |
| `Balance` (default) | Lock to one account, but switch immediately on rate limit |
| `PerformanceFirst` | Pure round-robin; best load spread, ignores cache |

Supporting mechanisms worth adopting:
- `session_manager.rs` derives a session fingerprint by hashing **only the first
  user message** (never model name or timestamp) so every turn of a conversation
  maps to the same id and the cache anchor never drifts.
- `token_manager.rs::select_with_p2c` uses **power-of-two-choices**: sample two
  candidates from the top-N by remaining quota and take the higher. This spreads
  load without the herd behaviour of strict "always pick the emptiest".
- Quota protection marks per-model `protected_models` so an account can be
  reserved for a model it still has budget for.
- `rate_limit.rs` tracks lockout per `account+model`, parsing retry hints from
  the response body rather than assuming a fixed backoff.

### Design adopted here

Three layers, in priority order:

1. **Affinity (cache)** — a conversation sticks to its account. Selection is
   HRW-keyed on a stable conversation fingerprint, matching stock's approach.
2. **Usage-aware placement** — quota is consulted **only when the cache is
   already cold** (new conversation, or the bound account is unusable). At that
   moment switching is free, so place the work on the account with the most
   headroom via power-of-two-choices. Kiro exposes `getUsageLimits`
   (`usedCount`/`limitCount`) for this.
3. **429 failover** — last-resort safety net; already implemented and tested.

Scheduling modes mirror Antigravity (`cache-first` / `balanced` / `spread`) so
the cache-vs-spread tradeoff is a user decision, not a hardcoded guess.

## Multi-account for addon providers

Reuse the *shape* stock uses for Anthropic so behaviour is consistent:
- named account slots persisted per provider,
- `blockedUntil` + `blockReason` for 429/auth errors, exponential backoff, capped,
- pin / unpin, with CLI flag override > settings > stored pin,
- selection strategies: `fill-first` (default, matches upstream practice) and `rotate`.

## Credential storage & keychain (requirement 7)

Default: `~/.senpi/agent/auth.json` (0600), same file stock uses.
Optional: macOS Keychain via `security` CLI, opt-in per provider. Must be verified by a
real round-trip test before being recommended.
