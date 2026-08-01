import { request as httpsRequest } from "node:https";

/**
 * A `fetch`-shaped client pinned to HTTP/1.1.
 *
 * Node's global `fetch` (undici) negotiates h2 over ALPN. `chatgpt.com` answers
 * an h2 request to `/backend-api/codex/usage` with a 403 bot-challenge *page*
 * rather than JSON, while the identical request over HTTP/1.1 returns 200 —
 * measured against two live accounts with curl (`--http1.1` 200 vs default h2
 * 403), python urllib (200) and `node:https` (200). No header combination
 * changes the h2 answer, so the protocol is the variable, and this exists to
 * pin it.
 *
 * Only the sliver of the Response contract these callers use is implemented:
 * `ok`, `status` and `json()`.
 */

export interface Http1Response {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export function http1Fetch(url: string, init: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
	const target = new URL(url);
	return new Promise<Http1Response>((resolve, reject) => {
		const req = httpsRequest(
			{
				host: target.host,
				path: `${target.pathname}${target.search}`,
				method: "GET",
				headers: init.headers ?? {},
				timeout: init.timeoutMs ?? 10_000,
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					resolve({
						ok: status >= 200 && status < 300,
						status,
						json: async () => JSON.parse(body) as unknown,
					});
				});
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("request timed out"));
		});
		req.on("error", reject);
		req.end();
	});
}
