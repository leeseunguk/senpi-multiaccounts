import {
	type AccountPoolState,
	type AccountSlot,
	blockAccount,
	clearFailureStreak,
	isBlocked,
	NoAvailableAccountError,
	recordFailureStreak,
	replaceAccount,
	unblockAccount,
} from "./accounts.js";
import { placeRequest, type SchedulingMode, type UsageSnapshot } from "./affinity.js";
import { classifyFailure, type FailureClassification, TRANSIENT_RETRY_MS } from "./failure.js";

export interface MigrationNotice {
	/** The account the conversation was bound to, whose prompt cache is now lost. */
	from: string;
	/** The account now serving it. */
	to: string;
}

export interface FailoverEvent {
	from: AccountSlot;
	to?: AccountSlot;
	reason: string;
	attempt: number;
}

/**
 * Raised when no account can serve the request.
 *
 * `retryAfterMs` matters for more than diagnostics: senpi's own
 * `SelectorCooldowns.durationFor()` prefers an explicit `retryAfterMs` over its
 * keyword heuristics. Carrying the real unblock time makes senpi suppress the
 * model for exactly as long as this pool is actually unusable, instead of
 * defaulting to its 30-minute quota bucket and idling accounts that recover
 * sooner.
 */
export class AllAccountsBlockedError extends Error {
	readonly retryAfterMs?: number;
	readonly retryAt?: number;

	constructor(message: string, retryAt?: number, now: number = Date.now()) {
		super(message);
		this.name = "AllAccountsBlockedError";
		if (retryAt !== undefined) {
			this.retryAt = retryAt;
			this.retryAfterMs = Math.max(0, retryAt - now);
		}
	}
}

/**
 * Explain a pool that has nothing selectable left.
 *
 * The bare "all accounts are blocked (rate limited or awaiting re-login)" was
 * actively misleading when the blocks came from upstream congestion: quota was
 * untouched, so the dashboard and the error disagreed. Naming the reason and the
 * earliest retry makes the two agree.
 */
function describeBlockedPool(accounts: readonly AccountSlot[], now: number): string {
	if (accounts.length === 0) return "No accounts are registered";
	const reasons = [...new Set(accounts.map((account) => account.blockReason ?? "unknown"))].sort();
	const soonest = accounts
		.filter((account) => account.blockReason !== "auth_error" && account.blockedUntil !== undefined)
		.reduce<{ name: string; at: number } | undefined>((best, account) => {
			const at = account.blockedUntil as number;
			return best === undefined || at < best.at ? { name: account.name, at } : best;
		}, undefined);

	const parts = [`All ${accounts.length} account(s) are blocked (${reasons.join(", ")})`];
	if (soonest) parts.push(`earliest retry in ${Math.max(0, Math.ceil((soonest.at - now) / 1000))}s (${soonest.name})`);
	if (reasons.includes("auth_error")) parts.push("at least one needs /login");
	if (!reasons.includes("quota") && !reasons.includes("rate_limit")) {
		parts.push("quota is not the limiting factor here");
	}
	return `${parts.join("; ")}.`;
}

export interface RunWithFailoverOptions<T> {
	state: AccountPoolState;
	/** Conversation fingerprint used for cache-preserving placement. */
	key: string;
	attempt: (account: AccountSlot) => Promise<T>;
	refresh?: (account: AccountSlot) => Promise<AccountSlot>;
	mode?: SchedulingMode;
	usage?: UsageSnapshot;
	maxAttempts?: number;
	onFailover?: (event: FailoverEvent) => void;
	/**
	 * Called only when a conversation irreversibly leaves the account holding its
	 * warm cache, and only under the `ask` policy. A reversible detour never
	 * fires this, so a rate limit stays silent.
	 */
	onMigration?: (notice: MigrationNotice) => void;
	onStateChange?: (state: AccountPoolState) => void;
	now?: () => number;
	refreshSkewMs?: number;
	random?: () => number;
	/** Injected so a congestion retry is not a wall-clock wait in tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Congestion retries on one account before it is blocked instead. */
	maxTransientRetries?: number;
}

export interface FailoverResult<T> {
	value: T;
	account: AccountSlot;
	state: AccountPoolState;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
const MAX_TRANSIENT_BACKOFF_MS = 2_000;
/**
 * Sidelining window for an account that keeps hitting upstream congestion.
 *
 * Deliberately seconds, not the minute a real fault earns: the account is
 * healthy and the upstream is expected back shortly, so this only stops the
 * current request from retrying the same busy account forever.
 */
const CONGESTION_SIDELINE_MS = 5_000;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function place(state: AccountPoolState, options: RunWithFailoverOptions<unknown>, now: number) {
	const placement: Parameters<typeof placeRequest>[1] = { key: options.key, now };
	if (options.mode !== undefined) placement.mode = options.mode;
	if (options.usage !== undefined) placement.usage = options.usage;
	if (options.random !== undefined) placement.random = options.random;
	return placeRequest(state, placement);
}

export interface AccountFailureTransition {
	state: AccountPoolState;
	classification: FailureClassification;
}

export function applyAccountFailure(
	state: AccountPoolState,
	account: AccountSlot,
	key: string,
	error: unknown,
	now: number = Date.now(),
	attempt = 0,
): AccountFailureTransition {
	const classification = classifyFailure(error);
	if (!classification.failover || classification.block === undefined) return { state, classification };

	// The streak persists on the slot, so a pool that keeps failing backs off
	// further each time instead of restarting at the base window on every request.
	const streaked = recordFailureStreak(account);
	const blockOptions: Parameters<typeof blockAccount>[2] = {
		now,
		attempt: Math.max(attempt, (streaked.consecutiveFailures ?? 1) - 1),
	};
	if (classification.retryAfterMs !== undefined) blockOptions.retryAfterMs = classification.retryAfterMs;
	// The binding is deliberately kept: blocking the account already routes this
	// and later requests elsewhere, and holding the binding lets the
	// conversation return to its warm cache once the block expires.
	return {
		state: replaceAccount(state, blockAccount(streaked, classification.block, blockOptions)),
		classification,
	};
}

/**
 * Run one request against the account pool.
 *
 * A failure that another account could survive (429, quota, auth, 5xx) blocks
 * the offending account and replays the request elsewhere; the conversation's
 * binding is retained so that once the block expires the conversation returns to
 * the account whose prompt-prefix cache is still warm.
 * Client-side errors propagate untouched, because replaying them would only
 * burn a second subscription on the same bad request.
 */
export async function runWithFailover<T>(options: RunWithFailoverOptions<T>): Promise<FailoverResult<T>> {
	const now = options.now ?? Date.now;
	const skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
	let state = options.state;
	const limit = options.maxAttempts ?? Math.max(1, state.accounts.length);
	const attemptsByAccount = new Map<string, number>();
	const transientByAccount = new Map<string, number>();
	const transientLimit = options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let lastError: unknown;
	const updateState = (next: AccountPoolState) => {
		state = next;
		options.onStateChange?.(state);
	};

	for (let attempt = 0; attempt < limit; attempt++) {
		let placement: ReturnType<typeof placeRequest>;
		try {
			placement = place(state, options as RunWithFailoverOptions<unknown>, now());
		} catch (error) {
			if (error instanceof NoAvailableAccountError) {
				if (lastError !== undefined) throw lastError;
				throw new AllAccountsBlockedError(describeBlockedPool(state.accounts, now()), error.retryAt, now());
			}
			throw error;
		}

		updateState(placement.state);
		if (placement.migratedFrom !== undefined) {
			options.onMigration?.({ from: placement.migratedFrom, to: placement.account.name });
		}
		let account = placement.account;

		if (options.refresh && account.expires <= now() + skew) {
			try {
				account = await options.refresh(account);
				updateState(replaceAccount(state, unblockAccount(account)));
			} catch (error) {
				lastError = error;
				updateState(replaceAccount(state, blockAccount(account, "auth_error")));
				options.onFailover?.({ from: account, reason: `token refresh failed: ${errorText(error)}`, attempt });
				continue;
			}
		}

		try {
			const value = await options.attempt(account);
			const settled = clearFailureStreak(account);
			if (settled !== account) updateState(replaceAccount(state, settled));
			return { value, account: settled, state };
		} catch (error) {
			lastError = error;
			const priorAttempts = attemptsByAccount.get(account.name) ?? 0;
			const transition = applyAccountFailure(state, account, options.key, error, now(), priorAttempts);
			const { classification } = transition;

			// Upstream congestion: the account is fine, so it keeps its slot and its
			// warm cache. Only a streak of them is treated as the account's problem.
			if (classification.transient === true && !(error as { committed?: boolean }).committed) {
				const used = transientByAccount.get(account.name) ?? 0;
				if (used < transientLimit) {
					transientByAccount.set(account.name, used + 1);
					const wait = Math.min(
						MAX_TRANSIENT_BACKOFF_MS,
						(classification.retryAfterMs ?? TRANSIENT_RETRY_MS) * 2 ** used,
					);
					options.onFailover?.({
						from: account,
						reason: `upstream busy: ${errorText(error)} (retrying on '${account.name}' in ${wait}ms)`,
						attempt,
					});
					await sleep(wait);
					attempt -= 1;
					continue;
				}
				// Sideline this account so the request stops retrying it -- but never
				// the last selectable one. Emptying the pool over the upstream's own
				// load is the incident this fix exists to prevent: the next request
				// would be refused outright even though the upstream may serve it.
				const others = state.accounts.filter(
					(candidate) => candidate.name !== account.name && !isBlocked(candidate, now()),
				);
				if (others.length === 0) {
					options.onFailover?.({
						from: account,
						reason: `upstream busy ${used + 1}x on '${account.name}'; it stays selectable as the last account`,
						attempt,
					});
					throw error;
				}
				attemptsByAccount.set(account.name, priorAttempts + 1);
				updateState(
					replaceAccount(
						state,
						blockAccount(account, "server_error", { now: now(), retryAfterMs: CONGESTION_SIDELINE_MS }),
					),
				);
				options.onFailover?.({
					from: account,
					reason: `upstream busy ${used + 1}x on '${account.name}'; sidelining it for ${CONGESTION_SIDELINE_MS}ms`,
					attempt,
				});
				continue;
			}

			if (!classification.failover || classification.block === undefined) throw error;
			attemptsByAccount.set(account.name, priorAttempts + 1);
			updateState(transition.state);

			// Providers tag a failure that arrived *after* visible output with
			// `committed`. Replaying such a turn on another account would emit the
			// partial text twice, so the account is still blocked (so later requests
			// route elsewhere) but this request fails rather than being retried.
			if ((error as { committed?: boolean }).committed) {
				options.onFailover?.({
					from: account,
					reason: `${classification.block}: ${errorText(error)} (output already streamed; not retrying)`,
					attempt,
				});
				throw error;
			}

			let next: AccountSlot | undefined;
			try {
				next = place(state, options as RunWithFailoverOptions<unknown>, now()).account;
			} catch {
				next = undefined;
			}

			const event: FailoverEvent = { from: account, reason: `${classification.block}: ${errorText(error)}`, attempt };
			if (next) event.to = next;
			options.onFailover?.(event);
		}
	}

	throw lastError ?? new AllAccountsBlockedError(describeBlockedPool(state.accounts, now()), undefined, now());
}
