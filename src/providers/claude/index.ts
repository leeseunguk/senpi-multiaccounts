import type { AccountSlot } from "../../core/accounts.js";
import type { ObserverPackage, ProviderBuildContext } from "../../core/types.js";
import { type AccountUsage, headroomOf } from "../../core/usage-window.js";
import { CLAUDE_SDK_PROVIDER_ID, readClaudePool, updateClaudePool } from "./store.js";
import { fetchClaudeUsage, refreshClaudeToken } from "./usage.js";

/**
 * Claude (Anthropic) multi-account observer.
 *
 * Stock senpi owns this pool end to end: it mints the tokens, streams, and
 * fails over. What it never had is a way to *see* the pool — `/usage` could
 * only count slots, so an account sitting at 100% weekly still read as
 * "available". This package adds the missing per-account usage, and the
 * pin/unblock/logout controls Kiro has and stock's `/claude-account` lacks.
 */

export { CLAUDE_SDK_PROVIDER_ID } from "./store.js";
export { fetchClaudeUsage, parseClaudeUsage, refreshClaudeToken, ClaudeUsageError } from "./usage.js";

export interface ClaudeProviderDeps {
	fetchUsage?: typeof fetchClaudeUsage;
	refresh?: typeof refreshClaudeToken;
	now?: () => number;
}

/**
 * Read one slot's usage, refreshing an expired token first.
 *
 * The refreshed pair is written straight back into stock's own record: Anthropic
 * rotates the refresh token on every exchange, so keeping the new access token
 * without persisting the new refresh token would leave stock holding a refresh
 * token the server has already retired.
 */
async function readSlotUsage(
	agentDir: string,
	slot: AccountSlot,
	deps: Required<Pick<ClaudeProviderDeps, "fetchUsage" | "refresh" | "now">>,
): Promise<AccountUsage | undefined> {
	let access = slot.access;

	if (slot.refresh && deps.now() >= slot.expires) {
		try {
			const refreshed = await deps.refresh(slot.refresh);
			access = refreshed.access;
			updateClaudePool(agentDir, (pool) => ({
				accounts: pool.accounts.map((candidate) =>
					candidate.name === slot.name ? { ...candidate, ...refreshed } : candidate,
				),
				...(pool.pinned === undefined ? {} : { pinned: pool.pinned }),
			}));
		} catch {
			return undefined;
		}
	}

	try {
		return await deps.fetchUsage(access);
	} catch {
		return undefined;
	}
}

async function readPoolUsage(
	context: ProviderBuildContext,
	deps: ClaudeProviderDeps,
): Promise<Record<string, AccountUsage | undefined>> {
	const resolved = {
		fetchUsage: deps.fetchUsage ?? fetchClaudeUsage,
		refresh: deps.refresh ?? refreshClaudeToken,
		now: deps.now ?? Date.now,
	};
	const pool = readClaudePool(context.agentDir);
	const entries = await Promise.all(
		pool.accounts.map(async (slot) => [slot.name, await readSlotUsage(context.agentDir, slot, resolved)] as const),
	);
	return Object.fromEntries(entries);
}

export function claudeProviderPackage(deps: ClaudeProviderDeps = {}): ObserverPackage {
	return {
		id: CLAUDE_SDK_PROVIDER_ID,
		label: "Claude (Anthropic)",
		enabled(_env, context) {
			if (context && !readClaudePool(context.agentDir).present) {
				return "no claude-agent-sdk credential; add one with /claude-account add";
			}
			return true;
		},
		readAccounts(context) {
			return readClaudePool(context.agentDir).accounts;
		},
		async accountUsageDetail(context) {
			return readPoolUsage(context, deps);
		},
		async accountUsage(context) {
			const detail = await readPoolUsage(context, deps);
			return Object.fromEntries(Object.entries(detail).map(([name, usage]) => [name, headroomOf(usage)]));
		},
	};
}
