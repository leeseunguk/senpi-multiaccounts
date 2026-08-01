import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountSlot } from "../../core/accounts.js";

/**
 * Read and write stock senpi's `claude-agent-sdk` account pool.
 *
 * This pool is owned by stock, not by this addon: stock mints the tokens, does
 * the streaming and the failover. The addon only observes it and edits the
 * fields stock already understands (`accounts`, `pinned`, `slotState`).
 *
 * So this deliberately does *not* reuse `core/store.ts`, which stamps its own
 * sentinel over the top-level `access` / `refresh` / `expires`. Stock asserts
 * those hold *its* sentinel and refuses to start otherwise, so every write here
 * preserves the record's existing fields verbatim and touches nothing else.
 */

export const CLAUDE_SDK_PROVIDER_ID = "claude-agent-sdk";

export interface ClaudeSlotState {
	blockedUntil?: number;
	blockReason?: string;
}

export interface ClaudeStoredPool {
	type: string;
	accounts?: AccountSlot[];
	pinned?: string;
	slotState?: Record<string, ClaudeSlotState>;
	[key: string]: unknown;
}

export interface ClaudePoolView {
	accounts: AccountSlot[];
	pinned?: string;
	/** Whether the provider key exists in `auth.json` at all. */
	present: boolean;
}

function authPath(agentDir: string): string {
	return join(agentDir, "auth.json");
}

function readAuthFile(agentDir: string): Record<string, unknown> {
	const path = authPath(agentDir);
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch (error) {
		throw new Error(
			`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
				"Fix or move the file; senpi-multiaccounts will not overwrite it.",
		);
	}
}

function writeAuthFile(agentDir: string, data: Record<string, unknown>): void {
	const path = authPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
	chmodSync(path, 0o600);
}

function storedPool(agentDir: string, providerId: string): ClaudeStoredPool | undefined {
	const entry = readAuthFile(agentDir)[providerId];
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	return entry as ClaudeStoredPool;
}

/**
 * Slots as stock resolves them: an env-sourced slot carries its block state in
 * `slotState` rather than on the slot itself, so the two are merged here.
 */
export function readClaudePool(agentDir: string, providerId = CLAUDE_SDK_PROVIDER_ID): ClaudePoolView {
	const stored = storedPool(agentDir, providerId);
	if (!stored) return { accounts: [], present: false };

	const slotState = stored.slotState ?? {};
	const accounts = (stored.accounts ?? []).map((slot) => {
		const persisted = slotState[slot.name];
		return persisted ? ({ ...slot, ...persisted } as AccountSlot) : slot;
	});

	const view: ClaudePoolView = { accounts, present: true };
	if (typeof stored.pinned === "string") view.pinned = stored.pinned;
	return view;
}

/** Rewrite only the pool-shaped fields, leaving every other key untouched. */
export function updateClaudePool(
	agentDir: string,
	update: (pool: ClaudePoolView) => { accounts: AccountSlot[]; pinned?: string },
	providerId = CLAUDE_SDK_PROVIDER_ID,
): void {
	const data = readAuthFile(agentDir);
	const existing = data[providerId];
	if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
		throw new Error(`No ${providerId} credential found. Add an account with /claude-account add first.`);
	}

	const current = readClaudePool(agentDir, providerId);
	const next = update(current);
	const stored = { ...(existing as ClaudeStoredPool) };
	stored.accounts = next.accounts;
	if (next.pinned === undefined) delete stored.pinned;
	else stored.pinned = next.pinned;

	data[providerId] = stored;
	writeAuthFile(agentDir, data);
}
