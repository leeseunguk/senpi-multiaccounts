import { defineConfig } from "vitest/config";

/**
 * At runtime senpi injects `@earendil-works/pi-ai` as a virtual module, so the
 * addon never depends on it being installed. Tests have no such injection, so
 * they resolve it to the copy nested inside the installed senpi — the exact
 * build the addon will run against.
 */
const PI_AI = "./node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist";

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: new URL(`${PI_AI}/index.js`, import.meta.url).pathname },
			{
				find: /^@earendil-works\/pi-ai\/(.*)$/,
				replacement: `${new URL(PI_AI, import.meta.url).pathname}/$1.js`,
			},
		],
	},
});
