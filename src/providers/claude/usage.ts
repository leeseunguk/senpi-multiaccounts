import { type AccountUsage, clampFraction, resetTimestamp, type UsageWindow } from "../../core/usage-window.js";

/**
 * Anthropic per-account usage.
 *
 * `https://api.anthropic.com/api/oauth/usage` answers a Claude Pro/Max OAuth
 * token with the same three windows the desktop apps show: a 5-hour session
 * window, a weekly window over every model, and a weekly window scoped to one
 * model family (currently Fable). Verified live against three real accounts.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";
const REQUEST_TIMEOUT_MS = 10_000;

/** Anthropic's own OAuth client id, as senpi's stock Anthropic flow uses it. */
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export class ClaudeUsageError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ClaudeUsageError";
		if (status !== undefined) this.status = status;
	}
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

/** A window is `{utilization|used_percentage, resets_at}` in either spelling. */
function toWindow(raw: unknown, label: string): UsageWindow | undefined {
	const entry = record(raw);
	if (!entry) return undefined;
	const percent =
		typeof entry.utilization === "number"
			? entry.utilization
			: typeof entry.used_percentage === "number"
				? entry.used_percentage
				: typeof entry.percent === "number"
					? entry.percent
					: undefined;
	if (percent === undefined) return undefined;
	const window: UsageWindow = { label, usedFraction: clampFraction(percent) };
	const resetsAt = resetTimestamp(entry.resets_at);
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	return window;
}

/**
 * The model-scoped weekly window.
 *
 * Its display name is a product decision that moves (it was Opus, it is now
 * Fable), so the scope's own `display_name` is used as the label rather than a
 * hardcoded one. Falls back to the legacy flat fields for older responses.
 */
function scopedWeeklyWindow(body: JsonRecord): UsageWindow | undefined {
	const limits = Array.isArray(body.limits) ? (body.limits as unknown[]) : [];
	for (const candidate of limits) {
		const limit = record(candidate);
		if (limit?.kind !== "weekly_scoped") continue;
		const name = record(record(limit.scope)?.model)?.display_name;
		const label = typeof name === "string" && name.trim() !== "" ? name.trim() : "scoped";
		const window = toWindow(limit, label);
		if (window) return { ...window, scoped: true };
	}
	const legacy =
		toWindow(body.fable_weekly, "Fable") ??
		toWindow(body.seven_day_opus, "Opus") ??
		toWindow(body.seven_day_sonnet, "Sonnet");
	return legacy ? { ...legacy, scoped: true } : undefined;
}

export function parseClaudeUsage(body: unknown): AccountUsage {
	const data = record(body) ?? {};
	const windows: UsageWindow[] = [];
	const session = toWindow(data.five_hour, "5h");
	if (session) windows.push(session);
	const weekly = toWindow(data.seven_day, "week");
	if (weekly) windows.push(weekly);
	const scoped = scopedWeeklyWindow(data);
	if (scoped) windows.push(scoped);
	return { windows };
}

export async function fetchClaudeUsage(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<AccountUsage> {
	const response = await fetchImpl(USAGE_URL, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			"anthropic-beta": BETA_HEADER,
			"user-agent": USER_AGENT,
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new ClaudeUsageError(`Claude usage request failed (HTTP ${response.status})`, response.status);
	}
	return parseClaudeUsage(await response.json());
}

export interface ClaudeTokens {
	access: string;
	refresh: string;
	/** Epoch millis. */
	expires: number;
}

/**
 * Refresh one slot's access token.
 *
 * A stale token answers the usage endpoint with HTTP 401, which would otherwise
 * read as "headroom unknown" and quietly drop the account from the dashboard —
 * the same trap Kiro's 403 posed.
 */
export async function refreshClaudeToken(
	refreshToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ClaudeTokens> {
	const response = await fetchImpl(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new ClaudeUsageError(`Claude token refresh failed (HTTP ${response.status})`, response.status);
	}
	const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
		throw new ClaudeUsageError("Claude token refresh returned an incomplete token");
	}
	// The five-minute safety margin matches stock senpi's own Anthropic refresh.
	return {
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1_000 - 5 * 60 * 1_000,
	};
}
