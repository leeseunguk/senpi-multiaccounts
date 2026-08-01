import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	addAccount,
	type AccountPoolState,
	assertValidAccountName,
	isBlocked,
	type MigrationPolicy,
	pinAccount,
	removeAccount,
	unblockAccount,
	unpinAccount,
} from "../../core/accounts.js";
import type { SchedulingMode } from "../../core/affinity.js";
import { migrationSink } from "../../core/migration-sink.js";
import { emptyPool, readPool, type StoredPool, updatePool } from "../../core/store.js";
import type { ProviderBuildContext, ProviderConfig, ProviderPackage } from "../../core/types.js";
import { createAccountUsageCache, type AccountUsageCache } from "../../core/usage-detail-cache.js";
import { type AccountUsage, headroomOf, syncQuotaBlock } from "../../core/usage-window.js";
import { resolveCodexModels } from "./models.js";
import { type CodexTokens, loginCodex, refreshCodex } from "./oauth.js";
import { createCodexStreamSimple } from "./stream.js";
import { fetchCodexUsage } from "./usage.js";

/**
 * OpenAI Codex multi-account.
 *
 * Stock senpi already ships the `openai-codex` provider, its Codex Responses
 * API and fast mode (`-fast` model variants + `service_tier: priority`). Only
 * the multi-account pool is missing, so this package registers a *separate*
 * provider id that reuses stock's API rather than replacing anything.
 *
 * Requests are authenticated per account by resolving the pool's active slot to
 * an access token; stock's API implementation does the actual streaming.
 */

export const CODEX_POOL_PROVIDER_ID = "codex-pool";

/**
 * Stock's `openai-codex-responses` streamer.
 *
 * `@earendil-works/pi-ai` is a real package only inside senpi's compiled Bun
 * binary (where it is injected as a virtual module). Running from source on
 * Node an extension has to resolve it itself, and the addon deliberately does
 * not depend on it -- see `../kiro/vendor/runtime.ts` for the same constraint.
 *
 * The Codex wire protocol is far too large to vendor, so instead of importing
 * the bare specifier this resolves the copy nested inside the senpi that is
 * actually running, via that module's own resolution root. Import failure is
 * surfaced as a normal error, which `runWithFailover` treats as this account's
 * attempt failing rather than taking the addon down.
 */
async function loadStockCodexStreamSimple(): Promise<
	(model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<unknown>
> {
	// A package `exports` map blocks deep subpath imports, so pi-ai's file is
	// located on disk and imported as a file URL. Node's own resolver is asked
	// first, which handles hoisting, pnpm layouts and workspace links; walking
	// fixed relative paths does not (verified by a clean tarball install, where
	// senpi is hoisted beside the addon rather than nested inside it).
	const SUBPATH = "@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates: string[] = [];

	/** Ask Node to resolve the subpath from an anchor, then walk that anchor up. */
	const probeFrom = (anchor: string): void => {
		try {
			candidates.push(pathToFileURL(createRequire(anchor).resolve(SUBPATH)).href);
		} catch {
			// Not resolvable from this anchor; the directory walk below still applies.
		}
		let dir = dirname(anchor);
		for (let i = 0; i < 7; i++) {
			candidates.push(pathToFileURL(join(dir, "node_modules", SUBPATH)).href);
			dir = dirname(dir);
		}
	};

	// The running senpi is the authoritative anchor: it owns the pi-ai build this
	// addon must match, and because senpi is a *peer* dependency it normally lives
	// outside the addon's own tree entirely (proved by a clean tarball install,
	// where the addon's node_modules contains no senpi at all).
	const senpiEntry = process.argv[1];
	if (senpiEntry) probeFrom(senpiEntry);

	// Installed as a real dependency or workspace link: resolve via senpi's root.
	try {
		probeFrom(createRequire(join(here, "index.js")).resolve("@code-yeongyu/senpi"));
	} catch {
		// Expected when senpi is only a peer dependency.
	}

	// Finally this module's own tree, covering a hoisted install.
	probeFrom(join(here, "index.js"));

	const specifiers = [
		// Bun binary: senpi's injected virtual module.
		"@earendil-works/pi-ai/api/openai-codex-responses",
		...new Set(candidates),
	];
	const failures: string[] = [];
	for (const specifier of specifiers) {
		try {
			const loaded = (await import(specifier)) as {
				streamSimple?: (
					model: Model<Api>,
					context: Context,
					options?: SimpleStreamOptions,
				) => AsyncIterable<unknown>;
			};
			if (loaded.streamSimple) return loaded.streamSimple;
			failures.push(`${specifier}: no streamSimple export`);
		} catch (error) {
			failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// Only the first failure is quoted: listing every probed path produced a
	// multi-line error that buried the actual cause.
	throw new Error(
		`codex-pool: could not load stock's Codex stream from @code-yeongyu/senpi ` +
			`(tried ${specifiers.length} location(s); first error: ${failures[0] ?? "none"}). ` +
			`Ensure @code-yeongyu/senpi is installed alongside this addon.`,
	);
}

function stockCodexStream(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const iterator = (async function* () {
		const streamSimple = await loadStockCodexStreamSimple();
		for await (const event of streamSimple(model, context, options)) yield event;
	})();
	return iterator as unknown as AssistantMessageEventStream;
}

type LoginCallbacks = Parameters<typeof loginCodex>[0] & {
	onSelect?(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
};

export function tokensToSlot(name: string, tokens: CodexTokens) {
	const meta: Record<string, unknown> = {};
	if (tokens.accountId) meta.accountId = tokens.accountId;
	if (tokens.email) meta.email = tokens.email;
	return {
		name,
		access: tokens.access,
		refresh: tokens.refresh,
		expires: tokens.expires,
		source: "login" as const,
		meta,
	};
}

function toStored(state: AccountPoolState): StoredPool {
	const pool = emptyPool();
	pool.accounts = state.accounts;
	if (state.pinned !== undefined) pool.pinned = state.pinned;
	if (state.mode !== undefined) pool.mode = state.mode;
	if (state.bindings !== undefined) pool.bindings = state.bindings;
	if (state.cursor !== undefined) pool.cursor = state.cursor;
	if (state.migration !== undefined) pool.migration = state.migration;
	return pool;
}

function describe(state: AccountPoolState, now: number): string {
	if (state.accounts.length === 0) return "No OpenAI accounts yet.";
	return state.accounts
		.map((slot) => {
			const marks: string[] = [];
			if (state.pinned === slot.name) marks.push("pinned");
			if (slot.blockReason === "auth_error") marks.push("needs re-login");
			else if (isBlocked(slot, now)) marks.push(`blocked ${Math.ceil(((slot.blockedUntil ?? now) - now) / 1000)}s`);
			else marks.push("available");
			const email = (slot.meta as { email?: string } | undefined)?.email;
			return `${email ? `${slot.name} <${email}>` : slot.name} — ${marks.join(", ")}`;
		})
		.join("\n");
}

async function addFlow(state: AccountPoolState, callbacks: LoginCallbacks): Promise<AccountPoolState> {
	const tokens = await loginCodex(callbacks);
	const suggested = state.accounts.length === 0 ? "default" : `account-${state.accounts.length + 1}`;
	const answer = (
		await callbacks.onPrompt({
			message:
				state.accounts.length === 0
					? "Name for this account"
					: `Name for this account (existing: ${state.accounts.map((s) => s.name).join(", ")})`,
			placeholder: suggested,
		})
	).trim();
	const name = answer || suggested;
	assertValidAccountName(name);
	return addAccount(state, tokensToSlot(name, tokens));
}

async function pick(state: AccountPoolState, callbacks: LoginCallbacks, message: string) {
	if (state.accounts.length === 0) return undefined;
	return callbacks.onSelect?.({
		message,
		options: state.accounts.map((slot) => ({ id: slot.name, label: slot.name })),
	});
}

async function accountManager(agentDir: string, callbacks: LoginCallbacks): Promise<StoredPool> {
	let state = readPool(agentDir, CODEX_POOL_PROVIDER_ID);
	if (state.accounts.length === 0 || !callbacks.onSelect) return toStored(await addFlow(state, callbacks));

	const action = await callbacks.onSelect({
		message: `OpenAI accounts\n${describe(state, Date.now())}`,
		options: [
			{ id: "add", label: "Add an account" },
			{ id: "remove", label: "Log out of one account" },
			{ id: "logout-all", label: "Log out of every account" },
			{ id: "pin", label: "Pin an account" },
			{ id: "unpin", label: "Clear the pin" },
			{ id: "unblock", label: "Clear a block" },
			{ id: "mode", label: "Scheduling mode" },
			{ id: "migrate", label: "Migration policy" },
		],
	});

	switch (action) {
		case "add":
			state = await addFlow(state, callbacks);
			break;
		case "remove": {
			const target = await pick(state, callbacks, "Log out of which account?");
			if (target) state = removeAccount(state, target);
			break;
		}
		// Full logout. The pin and conversation bindings go with the accounts, or
		// they would reference slots that no longer exist.
		case "logout-all": {
			const confirm = await callbacks.onSelect({
				message: `Log out of all ${state.accounts.length} OpenAI account(s)?`,
				options: [
					{ id: "no", label: "Cancel" },
					{ id: "yes", label: "Log out of every account" },
				],
			});
			if (confirm === "yes") {
				state = { ...state, accounts: [], bindings: {} };
				delete (state as { pinned?: string }).pinned;
			}
			break;
		}
		case "pin": {
			const target = await pick(state, callbacks, "Pin which account?");
			if (target) state = pinAccount(state, target);
			break;
		}
		case "unpin":
			state = unpinAccount(state);
			break;
		case "unblock": {
			const target = await pick(state, callbacks, "Clear the block on which account?");
			if (target) {
				state = {
					...state,
					accounts: state.accounts.map((slot) => (slot.name === target ? unblockAccount(slot) : slot)),
				};
			}
			break;
		}
		case "mode": {
			const selected = await callbacks.onSelect({
				message: "Scheduling mode",
				options: [
					{ id: "cache-first", label: "Cache first — hold one account, maximise prompt-cache hits" },
					{ id: "balanced", label: "Balanced — place new conversations by remaining quota" },
					{ id: "spread", label: "Spread — round-robin every request" },
				],
			});
			if (selected) state = { ...state, mode: selected as SchedulingMode };
			break;
		}
		case "migrate": {
			const selected = await callbacks.onSelect({
				message: "When a conversation can no longer use the account holding its warm cache",
				options: [
					{ id: "auto", label: "Auto — move it to another account silently" },
					{ id: "ask", label: "Ask — move it, but report the account it left" },
					{ id: "never", label: "Never — fail the request instead of moving it" },
				],
			});
			if (selected) state = { ...state, migration: selected as MigrationPolicy };
			break;
		}
		default:
			break;
	}

	return toStored(state);
}

/**
 * Per-account usage from ChatGPT's own endpoint.
 *
 * An expired access token answers HTTP 401, which would read as "headroom
 * unknown" and silently drop the account from `balanced` placement, so the slot
 * is refreshed first and the rotated pair persisted before the probe.
 */
async function readCodexSlotUsage(
	agentDir: string,
	name: string,
	cache: AccountUsageCache,
): Promise<AccountUsage | undefined> {
	const slot = readPool(agentDir, CODEX_POOL_PROVIDER_ID).accounts.find((candidate) => candidate.name === name);
	if (!slot) return undefined;

	let access = slot.access;
	let accountId = (slot.meta as { accountId?: string } | undefined)?.accountId;

	if (Date.now() >= slot.expires) {
		try {
			const refreshed = await refreshCodex({ access: slot.access, refresh: slot.refresh, expires: slot.expires });
			access = refreshed.access;
			accountId = refreshed.accountId ?? accountId;
			updatePool(agentDir, CODEX_POOL_PROVIDER_ID, (state) => ({
				...state,
				accounts: state.accounts.map((candidate) =>
					candidate.name === name ? tokensToSlot(name, refreshed) : candidate,
				),
			}));
		} catch {
			return undefined;
		}
	}

	try {
		return await cache.get(name, `${access}:${accountId ?? ""}`, () => fetchCodexUsage(access, accountId));
	} catch {
		return undefined;
	}
}

async function readCodexPoolUsage(
	context: ProviderBuildContext,
	cache: AccountUsageCache,
): Promise<Record<string, AccountUsage | undefined>> {
	const pool = readPool(context.agentDir, CODEX_POOL_PROVIDER_ID);
	const entries = await Promise.all(
		pool.accounts.map(
			async (slot) => [slot.name, await readCodexSlotUsage(context.agentDir, slot.name, cache)] as const,
		),
	);
	const detail = Object.fromEntries(entries);
	updatePool(context.agentDir, CODEX_POOL_PROVIDER_ID, (state) => ({
		...state,
		accounts: state.accounts.map((slot) => syncQuotaBlock(slot, detail[slot.name])),
	}));
	return detail;
}

export function codexProviderPackage(): ProviderPackage {
	const caches = new Map<string, AccountUsageCache>();
	const cacheFor = (agentDir: string) => {
		const existing = caches.get(agentDir);
		if (existing) return existing;
		const created = createAccountUsageCache(agentDir, CODEX_POOL_PROVIDER_ID);
		caches.set(agentDir, created);
		return created;
	};

	return {
		id: CODEX_POOL_PROVIDER_ID,
		label: "OpenAI Codex (pool)",
		enabled(env, context) {
			// Opt-in: stock `openai-codex` already covers the single-account case,
			// so an empty pool stays hidden. Once a pool exists, registration is
			// automatic and does not depend on a shell-specific environment export.
			return env.SENPI_ACCOUNTS_CODEX_POOL === "1" ||
				(context && readPool(context.agentDir, CODEX_POOL_PROVIDER_ID).accounts.length > 0)
				? true
				: "set SENPI_ACCOUNTS_CODEX_POOL=1 to enable the OpenAI Codex account pool";
		},
		build(context: ProviderBuildContext): ProviderConfig {
			return {
				name: "OpenAI Codex (pool)",
				baseUrl: "https://chatgpt.com/backend-api",
				api: "openai-codex-responses",
				// Required: an extension-registered provider id has no built-in
				// catalog to inherit, so omitting this registers zero models and
				// `--provider codex-pool` fails with "Unknown provider".
				models: resolveCodexModels(context.env),
				// Pool routing happens per request here, not via getApiKey: a
				// provider-level key is resolved once, so it could never rotate.
				streamSimple: createCodexStreamSimple(context.agentDir, {
					createStream: stockCodexStream,
					reportMigration: migrationSink.report,
				}),
				oauth: {
					name: "OpenAI Codex pool (ChatGPT Plus/Pro)",
					login: async (callbacks) => accountManager(context.agentDir, callbacks as unknown as LoginCallbacks) as never,
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			};
		},
		async accountUsageDetail(context) {
			return readCodexPoolUsage(context, cacheFor(context.agentDir));
		},
		async accountUsage(context) {
			const detail = await readCodexPoolUsage(context, cacheFor(context.agentDir));
			return Object.fromEntries(Object.entries(detail).map(([name, usage]) => [name, headroomOf(usage)]));
		},
	};
}

export { loginCodex, refreshCodex, CodexAuthError, type CodexTokens } from "./oauth.js";
