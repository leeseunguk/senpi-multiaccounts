/**
 * Multi-account slot model shared by every addon provider.
 *
 * Deliberately mirrors the shape stock senpi uses for the Claude Agent SDK
 * (`accounts`, `pinned`, `blockedUntil`, `blockReason`) so that account
 * behaviour is identical across stock and addon providers, and so a slot
 * persisted by one can be reasoned about by the other.
 */

export type BlockReason = "rate_limit" | "auth_error" | "quota" | "server_error";

export interface AccountSlot {
	/** Stable, user-facing slot name (`/kiro-account pin <name>`). */
	name: string;
	/** Long-lived credential material. */
	refresh: string;
	/** Short-lived credential material. */
	access: string;
	/** Epoch millis at which `access` expires. */
	expires: number;
	/** Where the slot came from. */
	source: "login" | "import" | "env";
	/** Epoch millis until which the slot must not be selected. */
	blockedUntil?: number;
	/** Why the slot is blocked. `auth_error` blocks until re-login. */
	blockReason?: BlockReason;
	/** Free-form provider metadata (region, profileArn, authMethod, ...). */
	meta?: Record<string, unknown>;
	/**
	 * Blocks in a row without an intervening success, so the backoff in
	 * {@link blockAccount} grows across requests instead of restarting at the
	 * base window every time. Cleared by {@link clearFailureStreak}.
	 */
	consecutiveFailures?: number;
}

export type SelectionStrategy = "fill-first" | "rotate";

/**
 * What may happen when a conversation can no longer use the account it is bound
 * to. A blocked account is a reversible detour and is never gated; this decides
 * only the irreversible case, where the bound account has left the pool.
 */
export type MigrationPolicy = "auto" | "ask" | "never";

export const MIGRATION_POLICIES: MigrationPolicy[] = ["auto", "ask", "never"];

export const DEFAULT_MIGRATION_POLICY: MigrationPolicy = "auto";

export interface AccountPoolState {
	accounts: AccountSlot[];
	/** Slot name pinned by the user; overrides strategy while available. */
	pinned?: string;
	strategy?: SelectionStrategy;
	/** Round-robin cursor, only meaningful for `rotate`/`spread`. */
	cursor?: number;
	/** Scheduling mode; see `affinity.ts`. */
	mode?: "cache-first" | "balanced" | "spread";
	/** Conversation fingerprint -> account name, preserving warm prompt caches. */
	bindings?: Record<string, string>;
	/** How to treat an irreversible move off a bound account; see {@link MigrationPolicy}. */
	migration?: MigrationPolicy;
}

export const MAX_BLOCK_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_BLOCK_MS = 60_000;

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function assertValidAccountName(name: string): void {
	if (!ACCOUNT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid account name '${name}': use letters, digits, '.', '-' or '_', starting with a letter or digit`,
		);
	}
}

/** An `auth_error` block has no expiry: it clears only on re-login. */
export function isBlocked(account: AccountSlot, now = Date.now()): boolean {
	if (account.blockReason === "auth_error") return true;
	return account.blockedUntil !== undefined && account.blockedUntil > now;
}

/** Drop expired timed blocks so the slot becomes selectable again (failback). */
export function clearExpiredBlocks(accounts: readonly AccountSlot[], now = Date.now()): AccountSlot[] {
	return accounts.map((account) => {
		if (account.blockReason === "auth_error") return account;
		if (account.blockedUntil !== undefined && account.blockedUntil <= now) {
			const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...available } = account;
			return available;
		}
		return account;
	});
}

export function addAccount(state: AccountPoolState, slot: AccountSlot): AccountPoolState {
	assertValidAccountName(slot.name);
	if (state.accounts.some((existing) => existing.name === slot.name)) {
		throw new Error(`Account '${slot.name}' already exists`);
	}
	return { ...state, accounts: [...state.accounts, slot] };
}

export function removeAccount(state: AccountPoolState, name: string): AccountPoolState {
	const accounts = state.accounts.filter((account) => account.name !== name);
	if (accounts.length === state.accounts.length) throw new Error(`Account '${name}' does not exist`);
	const next: AccountPoolState = { ...state, accounts };
	if (state.pinned === name) delete next.pinned;
	return next;
}

export function pinAccount(state: AccountPoolState, name: string): AccountPoolState {
	if (!state.accounts.some((account) => account.name === name)) {
		throw new Error(`Account '${name}' does not exist`);
	}
	return { ...state, pinned: name };
}

export function unpinAccount(state: AccountPoolState): AccountPoolState {
	const { pinned: _pinned, ...rest } = state;
	return rest;
}

export function replaceAccount(state: AccountPoolState, replacement: AccountSlot): AccountPoolState {
	return {
		...state,
		accounts: state.accounts.map((account) => (account.name === replacement.name ? replacement : account)),
	};
}

/**
 * Block a slot after a failure.
 *
 * `auth_error` is permanent until re-login. Everything else uses the upstream
 * `Retry-After` when present, otherwise exponential backoff on the attempt
 * count, always capped at {@link MAX_BLOCK_MS}.
 */
export function blockAccount(
	account: AccountSlot,
	reason: BlockReason,
	options: { now?: number; attempt?: number; retryAfterMs?: number; baseBlockMs?: number } = {},
): AccountSlot {
	if (reason === "auth_error") {
		const { blockedUntil: _blockedUntil, ...withoutExpiry } = account;
		return { ...withoutExpiry, blockReason: "auth_error" };
	}
	const now = options.now ?? Date.now();
	const attempt = options.attempt ?? 0;
	const base = options.baseBlockMs ?? DEFAULT_BLOCK_MS;
	const backoff = Math.min(MAX_BLOCK_MS, base * 2 ** attempt);
	const duration = Math.min(MAX_BLOCK_MS, options.retryAfterMs ?? backoff);
	return { ...account, blockedUntil: now + duration, blockReason: reason };
}

/** Count one more block against a slot, so the next backoff is longer. */
export function recordFailureStreak(account: AccountSlot): AccountSlot {
	return { ...account, consecutiveFailures: (account.consecutiveFailures ?? 0) + 1 };
}

/** Forget the streak after a request succeeds on this slot. */
export function clearFailureStreak(account: AccountSlot): AccountSlot {
	if (account.consecutiveFailures === undefined) return account;
	const { consecutiveFailures: _consecutiveFailures, ...rest } = account;
	return rest;
}

/** Clear an `auth_error` block, e.g. after a successful re-login. */
export function unblockAccount(account: AccountSlot): AccountSlot {
	const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...available } = account;
	return available;
}

export class NoAvailableAccountError extends Error {
	/** Earliest epoch-millis at which some slot unblocks, when one exists. */
	readonly retryAt?: number;

	constructor(message: string, retryAt?: number) {
		super(message);
		this.name = "NoAvailableAccountError";
		this.retryAt = retryAt;
	}
}

function earliestRetryAt(accounts: readonly AccountSlot[]): number | undefined {
	const times = accounts
		.filter((account) => account.blockReason !== "auth_error" && account.blockedUntil !== undefined)
		.map((account) => account.blockedUntil as number);
	return times.length > 0 ? Math.min(...times) : undefined;
}

export interface SelectOptions {
	now?: number;
	/** Strategy override; defaults to the pool's own, then `fill-first`. */
	strategy?: SelectionStrategy;
}

export interface Selection {
	account: AccountSlot;
	/** Pool state to persist (advances the round-robin cursor). */
	state: AccountPoolState;
}

/**
 * Pick the account to use for the next request.
 *
 * Order of precedence:
 *   1. the pinned slot, when it is not blocked (explicit user intent wins);
 *   2. the configured strategy over the unblocked slots:
 *      - `fill-first`: always the first unblocked slot, so one subscription is
 *        drained before the next is touched (matches how these subscriptions
 *        are actually metered);
 *      - `rotate`: round-robin, to spread load evenly.
 *
 * Timed blocks that have expired are cleared first, which is the failback path.
 */
export function selectAccount(state: AccountPoolState, options: SelectOptions = {}): Selection {
	const now = options.now ?? Date.now();
	const accounts = clearExpiredBlocks(state.accounts, now);
	const cleared: AccountPoolState = { ...state, accounts };

	if (accounts.length === 0) throw new NoAvailableAccountError("No accounts are registered");

	if (cleared.pinned) {
		const pinned = accounts.find((account) => account.name === cleared.pinned);
		if (pinned && !isBlocked(pinned, now)) return { account: pinned, state: cleared };
	}

	const available = accounts.filter((account) => !isBlocked(account, now));
	if (available.length === 0) {
		throw new NoAvailableAccountError(
			"All accounts are blocked (rate limited or awaiting re-login)",
			earliestRetryAt(accounts),
		);
	}

	const strategy = options.strategy ?? cleared.strategy ?? "fill-first";
	if (strategy === "fill-first") {
		return { account: available[0] as AccountSlot, state: cleared };
	}

	const cursor = cleared.cursor ?? 0;
	const account = available[cursor % available.length] as AccountSlot;
	return { account, state: { ...cleared, cursor: (cursor + 1) % available.length } };
}
