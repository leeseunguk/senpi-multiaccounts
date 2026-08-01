#!/usr/bin/env node

import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org";

export function decidePublish({ status, versions, version }) {
	if (status === 404) return { publish: true, reason: `${version} is the first version of this package` };
	// Fail closed: reading "already published" out of an unreachable registry would
	// silently drop a real release and still report the run as successful.
	if (status !== 200) throw new Error(`registry answered ${status}; refusing to guess whether ${version} exists`);
	if (versions.includes(version)) {
		return { publish: false, reason: `${version} is already on the registry` };
	}
	return { publish: true, reason: `${version} is not on the registry yet` };
}

async function readRegistry(name) {
	const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
		headers: { accept: "application/vnd.npm.install-v1+json" },
	});
	if (response.status !== 200) return { status: response.status, versions: [] };
	const body = await response.json();
	return { status: 200, versions: Object.keys(body.versions ?? {}) };
}

async function main() {
	const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
	const { name, version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const { status, versions } = await readRegistry(name);
	const { publish, reason } = decidePublish({ status, versions, version });

	console.log(`publish-guard: ${name}@${version}: ${reason}`);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
	}
	console.log(`publish=${publish}`);
}

// `/var/...` is a symlink to `/private/var/...` on macOS, so a temp-directory copy
// of this script compares unequal unless both sides are resolved.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	await main();
}
