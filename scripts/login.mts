/**
 * Scriptable Kiro login.
 *
 * `/login kiro` is the interactive path; this is the same flow driven from a
 * terminal so it can be automated (CI, QA, or headless setup). It prints the
 * authorize URL, waits for the localhost callback, then appends the account to
 * the pool in `SENPI_CODING_AGENT_DIR`.
 *
 *   npx tsx scripts/login.mts <account-name> [google|github|builder-id]
 */
import { addAccount } from "../src/core/accounts.ts";
import { readPool, writePool } from "../src/core/store.ts";
import { KIRO_PROVIDER_ID } from "../src/providers/kiro/config.ts";
import { fetchKiroUsage, loginKiro } from "../src/providers/kiro/oauth.ts";
import { tokensToSlot } from "../src/providers/kiro/provider.ts";

const name = process.argv[2];
const method = (process.argv[3] ?? "google") as "google" | "github" | "builder-id";
const agentDir = process.env.SENPI_CODING_AGENT_DIR;

if (!name) throw new Error("usage: login.mts <account-name> [google|github|builder-id]");
if (!agentDir) throw new Error("SENPI_CODING_AGENT_DIR must be set");

const tokens = await loginKiro(
	{
		onAuth: (info) => {
			console.log(`AUTH_URL ${info.url}`);
			if (info.instructions) console.log(`INFO ${info.instructions}`);
		},
		onDeviceCode: (info) => console.log(`DEVICE_CODE ${info.userCode} ${info.verificationUri}`),
		onProgress: (message) => console.log(`PROGRESS ${message}`),
		// Never resolves: the localhost callback server wins this race, and the
		// manual-paste branch is not usable from a non-interactive script.
		onPrompt: () => new Promise<string>(() => {}),
	},
	method,
);

let enriched = tokens;
try {
	const usage = await fetchKiroUsage(tokens);
	if (usage.email) enriched = { ...tokens, email: usage.email };
	console.log(`USAGE ${usage.usedCount}/${usage.limitCount} ${usage.email ?? ""}`);
} catch (error) {
	console.log(`USAGE_UNAVAILABLE ${error instanceof Error ? error.message : String(error)}`);
}

const pool = readPool(agentDir, KIRO_PROVIDER_ID);

// Kiro federates Google through Cognito, and Google's browser-wide SSO cookie
// re-authenticates the previous identity unless the *Google* session is
// switched first. Storing that under a new name would look like a second
// subscription while sharing one quota, so refuse it explicitly.
const duplicate = enriched.email
	? pool.accounts.find((slot) => (slot.meta as { email?: string } | undefined)?.email === enriched.email)
	: undefined;
if (duplicate) {
	console.error(
		`REFUSED: this login returned ${enriched.email}, already stored as '${duplicate.name}'.\n` +
			"Sign out of Kiro AND switch the Google account (https://accounts.google.com/Logout), then retry.",
	);
	process.exit(1);
}

writePool(agentDir, KIRO_PROVIDER_ID, addAccount(pool, tokensToSlot(name, enriched)));
console.log(`SAVED ${name}${enriched.email ? ` <${enriched.email}>` : ""}`);
process.exit(0);
