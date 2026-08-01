import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMacOS, keychainAvailable, writeSecret } from "../src/core/keychain.js";

/**
 * The availability probe must never attempt a write when no default keychain exists.
 * A write in that state makes macOS raise a modal "keychain could not be found" dialog,
 * which blocks any non-interactive run (CI, sandbox, the README doc-check).
 *
 * `security` is resolved through PATH, so a shim records exactly which subcommands the
 * probe issues.
 */
const runOnMac = isMacOS() ? describe : describe.skip;

runOnMac("keychain availability probe", () => {
	let shimDir: string;
	let logPath: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		shimDir = mkdtempSync(resolve(tmpdir(), "senpi-accounts-security-shim-"));
		logPath = resolve(shimDir, "calls.log");
		const shim = resolve(shimDir, "security");
		writeFileSync(
			shim,
			`#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(logPath)}\n` +
				`if [ "$1" = "default-keychain" ]; then\n  echo "security: SecKeychainCopyDefault: A default keychain could not be found." >&2\n  exit 1\nfi\nexit 0\n`,
		);
		chmodSync(shim, 0o755);
		writeFileSync(logPath, "");
		originalPath = process.env.PATH;
		process.env.PATH = shimDir;
	});

	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(shimDir, { recursive: true, force: true });
	});

	it("reports unavailable without issuing a write when no default keychain exists", () => {
		expect(keychainAvailable()).toBe(false);
		const calls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
		expect(calls).not.toContain("add-generic-password");
	});

	it("asks for the default keychain before anything else", () => {
		keychainAvailable();
		const calls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
		expect(calls[0]).toBe("default-keychain");
	});

	it("refuses a write instead of raising the modal when no default keychain exists", () => {
		expect(() => writeSecret("probe-provider", "value")).toThrow(/keychain/i);
		const calls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
		expect(calls).not.toContain("add-generic-password");
	});
});
