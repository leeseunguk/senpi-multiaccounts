import { execFileSync } from "node:child_process";

/**
 * Optional macOS Keychain storage for account pools.
 *
 * Off by default: pools live in senpi's `auth.json`, written atomically with
 * `0600`, which is the same protection stock uses. Keychain is offered for
 * users who want credentials out of the filesystem entirely, and is only used
 * when {@link keychainAvailable} confirms a working round-trip — a silent
 * failure here would lose accounts.
 */

const SERVICE_PREFIX = "senpi-accounts";

function service(providerId: string): string {
	return `${SERVICE_PREFIX}:${providerId}`;
}

function security(args: string[], input?: string): string {
	return execFileSync("security", args, {
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		...(input === undefined ? {} : { input }),
	});
}

export function isMacOS(): boolean {
	return process.platform === "darwin";
}

/**
 * Whether this process has a login keychain to write into.
 *
 * A user session has one; an isolated `HOME` (CI, a sandbox, the README doc-check) does
 * not. Writing in that state makes macOS raise a modal "keychain could not be found"
 * dialog that blocks the run until someone clicks it, so every entry point checks first.
 */
function defaultKeychainExists(): boolean {
	try {
		security(["default-keychain"]);
		return true;
	} catch {
		return false;
	}
}

/** Write a secret, replacing any existing entry for the provider. */
export function writeSecret(providerId: string, value: string): void {
	if (!isMacOS()) throw new Error("Keychain storage is only available on macOS");
	if (!defaultKeychainExists()) throw new Error("No default keychain to write into");
	// `-U` updates in place; without it a second write fails as a duplicate.
	security(["add-generic-password", "-a", process.env.USER ?? "senpi", "-s", service(providerId), "-w", value, "-U"]);
}

/** Read a secret, or undefined when no entry exists. */
export function readSecret(providerId: string): string | undefined {
	if (!isMacOS()) return undefined;
	try {
		return security(["find-generic-password", "-a", process.env.USER ?? "senpi", "-s", service(providerId), "-w"]).trim();
	} catch {
		return undefined;
	}
}

/** Remove a secret. Returns whether an entry was deleted. */
export function deleteSecret(providerId: string): boolean {
	if (!isMacOS()) return false;
	try {
		security(["delete-generic-password", "-a", process.env.USER ?? "senpi", "-s", service(providerId)]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Confirm the Keychain actually works by round-tripping a probe value.
 *
 * Presence of the `security` binary is not enough: the keychain can be locked
 * or access denied, and either would silently drop credentials.
 */
export function keychainAvailable(): boolean {
	if (!isMacOS() || !defaultKeychainExists()) return false;
	const probe = `__probe__${process.pid}`;
	try {
		writeSecret(probe, "ok");
		const value = readSecret(probe);
		return value === "ok";
	} catch {
		return false;
	} finally {
		deleteSecret(probe);
	}
}
