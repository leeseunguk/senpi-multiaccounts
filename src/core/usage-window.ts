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

export interface UsageWindow {
	/** Short label shown in the dashboard, e.g. `5h`, `week`, `Fable`. */
	label: string;
	/** Fraction of the window already consumed, 0..1. */
	usedFraction: number;
	/** Epoch millis at which this window resets, when the upstream says. */
	resetsAt?: number;
}

export interface AccountUsage {
	windows: UsageWindow[];
	/** Subscription tier as the upstream names it (`pro`, `max`, ...). */
	plan?: string;
	/** Account identity, so a slot name that lies is still diagnosable. */
	email?: string;
}

/** Remaining headroom, 0..1, from the tightest window. Undefined when unknown. */
export function headroomOf(usage: AccountUsage | undefined): number | undefined {
	if (!usage || usage.windows.length === 0) return undefined;
	const worst = Math.max(...usage.windows.map((window) => window.usedFraction));
	return Math.min(1, Math.max(0, 1 - worst));
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
	return usage.windows.map((window) => formatWindow(window, now)).join(" · ");
}
