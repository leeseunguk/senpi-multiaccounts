#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = resolve(repositoryRoot, "README.md");

function usage() {
	console.error("Usage: node scripts/check-readme.mjs [--command <shell-command>]");
}

function parseOptions(argv) {
	if (argv.length === 0) return { command: undefined };
	if (argv.length === 2 && argv[0] === "--command" && argv[1]) {
		return { command: argv[1] };
	}
	usage();
	process.exit(2);
}

function shellBlocks(readme) {
	const blocks = [];
	const pattern = /```(sh|bash)\n([\s\S]*?)\n```/g;
	for (const match of readme.matchAll(pattern)) {
		blocks.push(match[2]);
	}
	return blocks;
}

const { command } = parseOptions(process.argv.slice(2));
const blocks = shellBlocks(readFileSync(readmePath, "utf8"));
if (blocks.length === 0) {
	console.error("doc-check: FAIL: README contains no shell command blocks");
	process.exit(1);
}

const home = mkdtempSync(resolve(tmpdir(), "senpi-multiaccounts-doc-check-"));
// The README's install blocks install packages and clone the repository. Running them
// in the repository root would rewrite package.json and leave a nested checkout behind,
// so they get a scratch working directory of their own.
const workdir = mkdtempSync(resolve(tmpdir(), "senpi-multiaccounts-doc-work-"));
const script = ["set -eu", ...blocks.map((block, index) => `# README command block ${index + 1}\n${block}`)];
if (command) {
	script.push(`# injected verification command\n${command}`);
}

console.log(`doc-check: executing ${blocks.length} README shell command block(s)`);
let exitCode = 1;
try {
	const result = spawnSync("/bin/sh", ["-eu", "-c", script.join("\n\n")], {
		cwd: workdir,
		env: {
			...process.env,
			HOME: home,
			SENPI_CODING_AGENT_DIR: resolve(home, ".senpi", "agent"),
			NO_COLOR: "1",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
		},
		encoding: "utf8",
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.error) {
		console.error(`doc-check: FAIL: could not start shell: ${result.error.message}`);
	} else if (result.status === 0) {
		console.log("doc-check: PASS");
		exitCode = 0;
	} else {
		console.error(`doc-check: FAIL: command exited ${result.status ?? "by signal"}`);
	}
} finally {
	rmSync(home, { recursive: true, force: true });
	rmSync(workdir, { recursive: true, force: true });
	console.log("doc-check: cleanup: removed isolated temporary home and working directory");
}

process.exit(exitCode);
