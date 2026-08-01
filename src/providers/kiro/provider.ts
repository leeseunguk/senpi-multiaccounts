import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AccountSlot } from "../../core/accounts.js";
import { conversationKeyFor } from "../../core/affinity.js";
import { applyAccountFailure, type MigrationNotice, runWithFailover } from "../../core/failover.js";
import { readPool, writePool } from "../../core/store.js";
import { createUsageCache, type UsageCache } from "../../core/usage-cache.js";
import type { ProviderBuildContext, ProviderConfig } from "../../core/types.js";
import {
	KIRO_API,
	KIRO_MAX_OUTPUT_TOKENS,
	KIRO_PROVIDER_ID,
	KIRO_REGION,
	KIRO_REQUEST_TIMEOUT_MS,
	KIRO_UPSTREAM_URL,
	resolveModels,
} from "./config.js";
import { fetchKiroUsage, type KiroTokens, refreshKiro } from "./oauth.js";
import { DebugLogger } from "./vendor/debug-logger.js";
import { createKiroStream } from "./vendor/kiro.js";

/**
 * Kiro provider.
 *
 * Streaming is delegated to the vendored CodeWhisperer client; this module owns
 * the multi-account layer: pick the account, inject that account's token, and
 * on a retryable failure block it and replay on the next account.
 */

const PROFILE_ARN_HEADER = "x-kiro-profile-arn";

export function slotToTokens(slot: AccountSlot): KiroTokens {
	const meta = (slot.meta ?? {}) as Partial<KiroTokens>;
	const tokens: KiroTokens = {
		access: slot.access,
		refresh: slot.refresh,
		expires: slot.expires,
		authMethod: meta.authMethod ?? "google",
		region: meta.region ?? KIRO_REGION,
	};
	if (meta.profileArn) tokens.profileArn = meta.profileArn;
	if (meta.clientId) tokens.clientId = meta.clientId;
	if (meta.clientSecret) tokens.clientSecret = meta.clientSecret;
	if (meta.email) tokens.email = meta.email;
	return tokens;
}

export function tokensToSlot(name: string, tokens: KiroTokens, source: AccountSlot["source"] = "login"): AccountSlot {
	const meta: Record<string, unknown> = { authMethod: tokens.authMethod, region: tokens.region };
	if (tokens.profileArn) meta.profileArn = tokens.profileArn;
	if (tokens.clientId) meta.clientId = tokens.clientId;
	if (tokens.clientSecret) meta.clientSecret = tokens.clientSecret;
	if (tokens.email) meta.email = tokens.email;

	return { name, access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, source, meta };
}

/** Minimal config surface the vendored stream reads. */
function streamConfig(profileArn: string | undefined) {
	return {
		providerId: KIRO_PROVIDER_ID,
		upstreamUrl: KIRO_UPSTREAM_URL,
		endpoint: "codewhisperer" as const,
		apiKey: "kiro-managed",
		requestTimeoutMs: KIRO_REQUEST_TIMEOUT_MS,
		headers: {},
		...(profileArn ? { profileArn } : {}),
	};
}

const silentLogger = { debug: () => undefined, warn: () => undefined, error: () => undefined };

/** First user message text, used as the cache-affinity anchor. */
export function firstUserText(context: Context): string | undefined {
	for (const message of context.messages ?? []) {
		if (message.role !== "user") continue;
		const content = message.content as unknown;
		if (typeof content === "string") {
			if (content.trim()) return content;
			continue;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((block): block is { type: "text"; text: string } => (block as { type?: string })?.type === "text")
				.map((block) => block.text)
				.join(" ")
				.trim();
			if (text) return text;
		}
	}
	return undefined;
}

type KiroStreamEvent = Record<string, unknown>;

interface PreparedKiroStream {
	buffered: KiroStreamEvent[];
	tail?: AsyncIterator<KiroStreamEvent>;
}

function streamError(event: KiroStreamEvent): Error | undefined {
	if (event.type !== "error") return undefined;
	const raw = event.error as { errorMessage?: string } | undefined;
	return new Error(raw?.errorMessage ?? "Kiro request failed");
}

function isVisibleDelta(event: KiroStreamEvent): boolean {
	const type = typeof event.type === "string" ? event.type : "";
	return /^(?:text|thinking|toolcall)_delta$/.test(type);
}

/**
 * Read only until output is committed.
 *
 * A failure before the first visible delta is safe to retry on another account.
 * Once a delta arrives, return the still-open iterator so the caller can stream
 * it live instead of waiting for the complete response.
 *
 * A pre-delta failure abandons this iterator -- the turn is about to be retried
 * on another account -- so it is closed here. Without that, every failover would
 * leave the previous attempt's upstream response open.
 */
async function prepareStream(stream: AssistantMessageEventStream): Promise<PreparedKiroStream> {
	const iterator = (stream as AsyncIterable<KiroStreamEvent>)[Symbol.asyncIterator]();
	const buffered: KiroStreamEvent[] = [];

	try {
		for (;;) {
			const next = await iterator.next();
			if (next.done) return { buffered };
			const error = streamError(next.value);
			if (error) throw error;
			buffered.push(next.value);
			if (isVisibleDelta(next.value)) return { buffered, tail: iterator };
		}
	} catch (error) {
		await iterator.return?.();
		throw error;
	}
}

async function* emitPreparedStream(prepared: PreparedKiroStream): AsyncGenerator<KiroStreamEvent> {
	const tail = prepared.tail;
	try {
		for (const event of prepared.buffered) yield event;
		if (!tail) return;
		for (;;) {
			const next = await tail.next();
			if (next.done) return;
			const error = streamError(next.value);
			if (error) throw error;
			yield next.value;
		}
	} finally {
		await tail?.return?.();
	}
}

export interface KiroProviderDeps {
	readPoolState?: typeof readPool;
	writePoolState?: typeof writePool;
	refresh?: (tokens: KiroTokens) => Promise<KiroTokens>;
	createStream?: typeof createKiroStream;
	onFailover?: (message: string) => void;
	reportMigration?: (providerId: string, notice: MigrationNotice) => void;
	logger?: DebugLogger;
	/** Per-account headroom source for `balanced` placement. */
	usage?: UsageCache;
}

/**
 * Read one account's usage, refreshing an expired access token first.
 *
 * An expired token makes the usage endpoint answer 403, which previously read as
 * "headroom unknown" and quietly excluded that account from usage-aware
 * placement. The refresh is best-effort and its result is not persisted here:
 * this is a read-only probe, and the request path refreshes and stores tokens on
 * its own.
 */
export async function readKiroHeadroom(
	slot: AccountSlot,
	deps: { refresh?: (tokens: KiroTokens) => Promise<KiroTokens> } = {},
): Promise<number | undefined> {
	const refreshTokens = deps.refresh ?? refreshKiro;
	let tokens = slotToTokens(slot);
	if (Date.now() >= slot.expires) {
		try {
			tokens = await refreshTokens(tokens);
		} catch {
			return undefined;
		}
	}
	try {
		const usage = await fetchKiroUsage(tokens);
		if (usage.limitCount <= 0) return undefined;
		return Math.max(0, 1 - usage.usedCount / usage.limitCount);
	} catch {
		return undefined;
	}
}

/** Live per-account headroom, 0..1, from Kiro's own usage-limits endpoint. */
function kiroUsageCache(
	agentDir: string,
	readState: typeof readPool,
	refresh?: (tokens: KiroTokens) => Promise<KiroTokens>,
): UsageCache {
	return createUsageCache(async () => {
		const state = readState(agentDir, KIRO_PROVIDER_ID);
		const entries = await Promise.all(
			state.accounts.map(
				async (slot) => [slot.name, await readKiroHeadroom(slot, refresh ? { refresh } : {})] as const,
			),
		);
		return Object.fromEntries(entries);
	});
}

export function createKiroStreamSimple(agentDir: string, deps: KiroProviderDeps = {}) {
	const readState = deps.readPoolState ?? readPool;
	const writeState = deps.writePoolState ?? writePool;
	const refreshTokens = deps.refresh ?? refreshKiro;
	const makeStream = deps.createStream ?? createKiroStream;
	// One cache per provider instance, so the TTL is shared across requests.
	const usageCache = deps.usage ?? kiroUsageCache(agentDir, readState, refreshTokens);

	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		// Read per request so a login or pin made elsewhere takes effect on the
		// very next turn.
		const state = readState(agentDir, KIRO_PROVIDER_ID);
		// senpi's session id is stable for the whole session; the first user message
		// is not — compaction replaces it with the summary, which silently changed
		// the key mid-conversation and threw away the warm binding. Anchor on the
		// session id, keep content hashing as the fallback.
		const key = conversationKeyFor({
			sessionId: options?.sessionId,
			firstUserMessage: firstUserText(context),
		});

		const iterator = (async function* () {
			const result = await runWithFailover({
				state,
				key,
				// Only consulted for a cold conversation in `balanced` mode; a warm
				// binding and `cache-first` both keep the conversation where it is.
				...(usageCache.get() ? { usage: usageCache.get() } : {}),
				refresh: async (account) => {
					const refreshed = await refreshTokens(slotToTokens(account));
					return tokensToSlot(account.name, refreshed, account.source);
				},
				onFailover: (event) => {
					deps.onFailover?.(
						`kiro: account '${event.from.name}' failed (${event.reason}); ` +
							(event.to ? `retrying on '${event.to.name}'` : "no account left to try"),
					);
				},
				onMigration: (notice) => deps.reportMigration?.(KIRO_PROVIDER_ID, notice),
				onStateChange: (next) => writeState(agentDir, KIRO_PROVIDER_ID, next),
				attempt: async (account) => {
					const tokens = slotToTokens(account);
					const headers = { ...options?.headers };
					if (tokens.profileArn) headers[PROFILE_ARN_HEADER] = tokens.profileArn;

					const stream = makeStream(streamConfig(tokens.profileArn) as never, {}, deps.logger ?? (silentLogger as never))(
						model,
						context,
						{ ...options, apiKey: tokens.access, headers } as SimpleStreamOptions,
					);
					return prepareStream(stream);
				},
			});

			try {
				yield* emitPreparedStream(result.value);
			} catch (error) {
				const transition = applyAccountFailure(result.state, result.account, key, error);
				if (transition.classification.failover && transition.classification.block !== undefined) {
					writeState(agentDir, KIRO_PROVIDER_ID, transition.state);
					deps.onFailover?.(
						`kiro: account '${result.account.name}' failed (${transition.classification.block}: ` +
							`${error instanceof Error ? error.message : String(error)}; output already streamed; not retrying)`,
					);
				}
				throw error;
			}
		})();

		return iterator as unknown as AssistantMessageEventStream;
	};
}

export function buildKiroProviderConfig(
	context: ProviderBuildContext,
	oauth: ProviderConfig["oauth"],
	deps: KiroProviderDeps = {},
): ProviderConfig {
	const models = resolveModels(context.env).map((model) => ({
		...model,
		maxTokens: Math.min(model.maxTokens, KIRO_MAX_OUTPUT_TOKENS),
	}));
	const logger =
		deps.logger ??
		new DebugLogger({
			extensionRoot: context.agentDir,
			debug: /^(?:1|true|yes)$/i.test(context.env.KIRO_DEBUG?.trim() ?? ""),
		});

	return {
		name: "Kiro",
		baseUrl: KIRO_UPSTREAM_URL,
		api: KIRO_API as Api,
		// Deliberately no provider-level `apiKey`. Kiro is OAuth-only, and declaring
		// one made senpi offer "Sign in with an API key" in `/login kiro`, which
		// dead-ends at an "Enter API key" prompt that can never succeed. Each
		// request is authenticated by the pool in `streamSimple` instead.
		models,
		streamSimple: createKiroStreamSimple(context.agentDir, { ...deps, logger }),
		...(oauth ? { oauth } : {}),
	};
}
