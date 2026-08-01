import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountSlot } from "../../core/accounts.js";
import { notifyProviderAccountsChanged } from "../../core/account-events.js";

/**
 * Read and write stock senpi's `claude-sdk-oauth` account pool.
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

export const CLAUDE_SDK_PROVIDER_ID = "claude-sdk-oauth";

export interface ClaudeSlotState {
	blockedUntil?: number;
	blockReason?: AccountSlot["blockReason"];
}

export interface ClaudeStoredPool {
	type: string;
	access: string;
	refresh: string;
	expires: number;
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

/** Full stock credential for OAuth registration and account-management flows. */
export function readClaudeCredential(
	agentDir: string,
	providerId = CLAUDE_SDK_PROVIDER_ID,
): ClaudeStoredPool | undefined {
	return storedPool(agentDir, providerId);
}

/**
 * Slots as stock resolves them: an env-sourced slot carries its block state in
 * `slotState` rather than on the slot itself, so the two are merged here.
 */
export function readClaudePool(
	agentDir: string,
	providerId = CLAUDE_SDK_PROVIDER_ID,
	env: NodeJS.ProcessEnv = process.env,
): ClaudePoolView {
	const stored = storedPool(agentDir, providerId);
	if (!stored) return { accounts: [], present: false };

	const slotState = stored.slotState ?? {};
	const accounts = (stored.accounts ?? []).map((slot) => {
		const persisted = slotState[slot.name];
		return persisted ? ({ ...slot, ...persisted } as AccountSlot) : slot;
	});
	const environmentNames = [{ variable: "CLAUDE_CODE_OAUTH_TOKEN", name: "env" }];
	for (let index = 2; index <= 16; index++) {
		environmentNames.push({ variable: `CLAUDE_CODE_OAUTH_TOKEN_${index}`, name: `env-${index}` });
	}
	for (const { variable, name } of environmentNames) {
		const access = env[variable];
		if (!access) continue;
		accounts.push({
			name,
			access,
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
			source: "env",
			...slotState[name],
		});
	}

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
	const storedAccounts = next.accounts.filter((slot) => slot.source !== "env");
	const removedStoredNames = new Set(
		(stored.accounts ?? [])
			.filter((slot) => !storedAccounts.some((candidate) => candidate.name === slot.name))
			.map((slot) => slot.name),
	);
	stored.accounts = storedAccounts;
	const slotState = { ...(stored.slotState ?? {}) };
	for (const name of removedStoredNames) delete slotState[name];
	for (const slot of next.accounts.filter((candidate) => candidate.source === "env")) {
		if (slot.blockedUntil === undefined && slot.blockReason === undefined) delete slotState[slot.name];
		else {
			slotState[slot.name] = {
				...(slot.blockedUntil === undefined ? {} : { blockedUntil: slot.blockedUntil }),
				...(slot.blockReason === undefined ? {} : { blockReason: slot.blockReason }),
			};
		}
	}
	if (Object.keys(slotState).length === 0) delete stored.slotState;
	else stored.slotState = slotState;
	if (next.pinned === undefined) delete stored.pinned;
	else stored.pinned = next.pinned;

	data[providerId] = stored;
	writeAuthFile(agentDir, data);
	notifyProviderAccountsChanged(providerId);
}
