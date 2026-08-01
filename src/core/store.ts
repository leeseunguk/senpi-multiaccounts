import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountPoolState, AccountSlot, SelectionStrategy } from "./accounts.js";

/**
 * Account pools are persisted inside senpi's own `auth.json`, under the
 * provider's key, using the same field names stock senpi uses for the Claude
 * Agent SDK (`accounts`, `pinned`). Senpi treats the record as an opaque OAuth
 * credential, so the sentinel `access`/`refresh` keep it a valid credential
 * while the real per-account material lives in `accounts`.
 */
export const SENTINEL = {
	access: "senpi-accounts-managed",
	refresh: "senpi-accounts-managed",
	/** 2100-01-01: far enough out that senpi never tries to refresh the sentinel. */
	expires: 4_102_444_800_000,
} as const;

export interface StoredPool {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accounts?: AccountSlot[];
	pinned?: string;
	strategy?: SelectionStrategy;
	cursor?: number;
	mode?: AccountPoolState["mode"];
	bindings?: Record<string, string>;
	migration?: AccountPoolState["migration"];
}

export function emptyPool(): StoredPool {
	return { type: "oauth", ...SENTINEL, accounts: [] };
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
		// A corrupt auth.json must not be silently replaced: that would destroy
		// every other provider's credentials along with this one's.
		throw new Error(
			`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
				"Fix or move the file; senpi-accounts will not overwrite it.",
		);
	}
}

/**
 * Write `auth.json` atomically with 0600 permissions.
 *
 * Credentials are written to a temp file in the same directory and renamed, so
 * a crash mid-write cannot leave a truncated credential file behind.
 */
function writeAuthFile(agentDir: string, data: Record<string, unknown>): void {
	const path = authPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
	chmodSync(path, 0o600);
}

function toPoolState(stored: StoredPool): AccountPoolState {
	const state: AccountPoolState = { accounts: stored.accounts ?? [] };
	if (stored.pinned !== undefined) state.pinned = stored.pinned;
	if (stored.strategy !== undefined) state.strategy = stored.strategy;
	if (stored.cursor !== undefined) state.cursor = stored.cursor;
	if (stored.mode !== undefined) state.mode = stored.mode;
	if (stored.bindings !== undefined) state.bindings = stored.bindings;
	if (stored.migration !== undefined) state.migration = stored.migration;
	return state;
}

function isStoredPool(value: unknown): value is StoredPool {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "oauth";
}

/** Read a provider's account pool. Returns an empty pool when absent. */
export function readPool(agentDir: string, providerId: string): AccountPoolState {
	const entry = readAuthFile(agentDir)[providerId];
	return isStoredPool(entry) ? toPoolState(entry) : { accounts: [] };
}

/** Persist a provider's account pool, leaving every other provider untouched. */
export function writePool(agentDir: string, providerId: string, state: AccountPoolState): void {
	const data = readAuthFile(agentDir);
	const stored: StoredPool = { type: "oauth", ...SENTINEL, accounts: state.accounts };
	if (state.pinned !== undefined) stored.pinned = state.pinned;
	if (state.strategy !== undefined) stored.strategy = state.strategy;
	if (state.cursor !== undefined) stored.cursor = state.cursor;
	if (state.mode !== undefined) stored.mode = state.mode;
	if (state.bindings !== undefined) stored.bindings = state.bindings;
	if (state.migration !== undefined) stored.migration = state.migration;
	data[providerId] = stored;
	writeAuthFile(agentDir, data);
}

/** Read-modify-write a pool in one step. */
export function updatePool(
	agentDir: string,
	providerId: string,
	update: (state: AccountPoolState) => AccountPoolState,
): AccountPoolState {
	const next = update(readPool(agentDir, providerId));
	writePool(agentDir, providerId, next);
	return next;
}
