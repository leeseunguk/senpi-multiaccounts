import { http1Fetch } from "../../core/http1.js";
import { type AccountUsage, clampFraction, resetTimestamp, type UsageWindow } from "../../core/usage-window.js";

/**
 * OpenAI Codex per-account usage.
 *
 * `https://chatgpt.com/backend-api/codex/usage` answers a ChatGPT OAuth token
 * with `rate_limit.primary_window` / `secondary_window`, the plan type and the
 * account's email. Verified live against two real Pro accounts.
 */

const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const USER_AGENT = "codex-cli";
const REQUEST_TIMEOUT_MS = 10_000;

export class CodexUsageError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "CodexUsageError";
		if (status !== undefined) this.status = status;
	}
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

/**
 * Label a window by its own duration rather than a fixed name: OpenAI meters a
 * weekly primary window for Pro and a 5-hour one for Plus, under the same key.
 */
function windowLabel(seconds: unknown, fallback: string): string {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
	if (seconds >= 604_800) return "week";
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
	return `${Math.round(seconds / 3_600)}h`;
}

function toWindow(raw: unknown, fallbackLabel: string): UsageWindow | undefined {
	const entry = record(raw);
	if (entry === undefined) return undefined;
	const percent = entry.used_percent;
	if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
	const window: UsageWindow = {
		label: windowLabel(entry.limit_window_seconds, fallbackLabel),
		usedFraction: clampFraction(percent),
	};
	const resetsAt = resetTimestamp(entry.reset_at);
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	return window;
}

export function parseCodexUsage(body: unknown): AccountUsage {
	const data = record(body) ?? {};
	const rateLimit = record(data.rate_limit) ?? {};
	const windows: UsageWindow[] = [];
	const primary = toWindow(rateLimit.primary_window, "primary");
	if (primary) windows.push(primary);
	const secondary = toWindow(rateLimit.secondary_window, "secondary");
	if (secondary) windows.push(secondary);

	const usage: AccountUsage = { windows };
	if (typeof data.plan_type === "string" && data.plan_type !== "") usage.plan = data.plan_type;
	if (typeof data.email === "string" && data.email !== "") usage.email = data.email;
	return usage;
}

export type UsageFetch = (
	url: string,
	init: { headers?: Record<string, string>; timeoutMs?: number },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchCodexUsage(
	accessToken: string,
	accountId: string | undefined,
	fetchImpl: UsageFetch = http1Fetch,
): Promise<AccountUsage> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${accessToken}`,
		"user-agent": USER_AGENT,
	};
	if (accountId) headers["chatgpt-account-id"] = accountId;

	const response = await fetchImpl(USAGE_URL, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
	if (!response.ok) {
		throw new CodexUsageError(`Codex usage request failed (HTTP ${response.status})`, response.status);
	}
	return parseCodexUsage(await response.json());
}
