/**
 * Per-account usage windows.
 *
 * A subscription is not one number. Anthropic meters a 5-hour session window, a
 * weekly window over every model, and a second weekly window scoped to one
 * model family; OpenAI meters a primary window and sometimes a secondary one.
 * Collapsing those into a single "headroom" percentage is what made the old
 * dashboard say `3/3 accounts available` while one account was at 100% weekly.
 *
 * So a provider reports a list of windows and the dashboard renders them all.
 * Routing still needs one number, and {@link headroomOf} supplies it: the
 * tightest window wins, because that is the one that will actually refuse the
 * next request.
 */

import type { AccountSlot } from "./accounts.js";

export interface UsageWindow {
	/** Short label shown in the dashboard, e.g. `5h`, `week`, `Fable`. */
	label: string;
	/** Fraction of the window already consumed, 0..1. */
	usedFraction: number;
	/** Epoch millis at which this window resets, when the upstream says. */
	resetsAt?: number;
	/**
	 * Whether the window meters one model family rather than the subscription.
	 *
	 * A spent scoped window (Fable at 100%) refuses only that family; the account
	 * still serves every other model. Blocking the whole slot on it would retire a
	 * working subscription, so exhaustion gating ignores scoped windows.
	 */
	scoped?: boolean;
}

export interface AccountUsage {
	windows: UsageWindow[];
	/** Subscription tier as the upstream names it (`pro`, `max`, ...). */
	plan?: string;
	/** Account identity, so a slot name that lies is still diagnosable. */
	email?: string;
	/** True when the vendor refresh failed and a persisted snapshot is shown. */
	stale?: boolean;
}

/** Remaining headroom, 0..1, from the tightest window. Undefined when unknown. */
export function headroomOf(usage: AccountUsage | undefined): number | undefined {
	if (!usage || usage.windows.length === 0) return undefined;
	const unscoped = usage.windows.filter((window) => !window.scoped);
	if (unscoped.length === 0) return undefined;
	const worst = Math.max(...unscoped.map((window) => window.usedFraction));
	return Math.min(1, Math.max(0, 1 - worst));
}

/**
 * Synchronize the persisted routing block with authoritative quota windows.
 *
 * A model-scoped limit must never retire the whole subscription. For global
 * limits, the account stays blocked until every exhausted window has reset,
 * hence the latest reset wins. A later successful refresh clears quota blocks
 * but never overrides auth, rate-limit, or server-error state.
 */
export function syncQuotaBlock(account: AccountSlot, usage: AccountUsage | undefined, now = Date.now()): AccountSlot {
	const resetTimes =
		usage?.windows
			.filter(
				(window) =>
					!window.scoped &&
					window.usedFraction >= 1 &&
					window.resetsAt !== undefined &&
					window.resetsAt > now,
			)
			.map((window) => window.resetsAt as number) ?? [];

	if (resetTimes.length > 0 && account.blockReason !== "auth_error") {
		return { ...account, blockReason: "quota", blockedUntil: Math.max(...resetTimes) };
	}

	if (account.blockReason !== "quota") return account;
	const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...available } = account;
	return available;
}

export function clampFraction(percent: number): number {
	return Math.min(1, Math.max(0, percent / 100));
}

/** Parse an ISO timestamp or epoch seconds into epoch millis. */
export function resetTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		// Epoch seconds (OpenAI) vs millis: anything below year 2286 in millis
		// would be 1970 in seconds, so treat small numbers as seconds.
		return value < 1e11 ? Math.round(value * 1_000) : Math.round(value);
	}
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = new Date(value).getTime();
	return Number.isNaN(parsed) ? undefined : parsed;
}

function shortDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * Render one window as `7% 5h 4h 7m`: used, window label, time until reset.
 *
 * Time-to-reset rather than a wall-clock date, because "resets in 4h" is the
 * question a user actually has, and it needs no timezone reasoning.
 */
export function formatWindow(window: UsageWindow, now = Date.now()): string {
	const used = `${Math.round(window.usedFraction * 100)}%`;
	if (window.resetsAt === undefined) return `${used} ${window.label}`;
	const remaining = window.resetsAt - now;
	if (remaining <= 0) return `${used} ${window.label}`;
	return `${used} ${window.label} ${shortDuration(remaining)}`;
}

/** Render every window of one account, e.g. `7% 5h 4h 7m · 38% week 5d · 51% Fable 5d`. */
export function formatUsage(usage: AccountUsage, now = Date.now()): string {
	const windows = usage.windows.map((window) => formatWindow(window, now)).join(" · ");
	return usage.stale ? `${windows} · stale` : windows;
}
