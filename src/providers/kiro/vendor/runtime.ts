import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Usage } from "@earendil-works/pi-ai";

/**
 * Local implementations of the only two runtime values the vendored
 * CodeWhisperer client needs from `@earendil-works/pi-ai`.
 *
 * senpi injects `@earendil-works/pi-ai` as a virtual module only in its
 * compiled Bun binary; running from source on Node, an extension must resolve
 * the package itself. Depending on it directly would either force a duplicate
 * copy (which breaks type identity against senpi's own) or make the addon
 * fragile to senpi's internal layout. Both functions are small and stable, so
 * owning them removes the runtime dependency entirely.
 */

type EventSink = { type: string; [key: string]: unknown };

/**
 * Minimal push-based async event stream.
 *
 * Mirrors the contract the vendored client relies on: `push` before or after a
 * consumer attaches, `end` to terminate iteration, and `result` to await the
 * final assistant message.
 */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	const queue: EventSink[] = [];
	const waiters: ((value: IteratorResult<EventSink>) => void)[] = [];
	let ended = false;
	let finalMessage: AssistantMessage | undefined;
	const settled: ((message: AssistantMessage) => void)[] = [];

	const stream = {
		push(event: EventSink): void {
			if (ended) return;
			const waiter = waiters.shift();
			if (waiter) waiter({ value: event, done: false });
			else queue.push(event);
		},

		end(message?: AssistantMessage): void {
			if (ended) return;
			ended = true;
			if (message) finalMessage = message;
			while (waiters.length > 0) {
				waiters.shift()?.({ value: undefined as never, done: true });
			}
			if (finalMessage) {
				for (const resolve of settled.splice(0)) resolve(finalMessage);
			}
		},

		result(): Promise<AssistantMessage> {
			if (finalMessage) return Promise.resolve(finalMessage);
			return new Promise<AssistantMessage>((resolve) => settled.push(resolve));
		},

		[Symbol.asyncIterator](): AsyncIterator<EventSink> {
			return {
				next(): Promise<IteratorResult<EventSink>> {
					const queued = queue.shift();
					if (queued) return Promise.resolve({ value: queued, done: false });
					if (ended) return Promise.resolve({ value: undefined as never, done: true });
					return new Promise<IteratorResult<EventSink>>((resolve) => waiters.push(resolve));
				},
			};
		},
	};

	return stream as unknown as AssistantMessageEventStream;
}

/**
 * Fill in usage cost from the model's per-million-token rates.
 *
 * Kiro is subscription-metered and its catalog rates are zero, so in practice
 * this records zeros; it is kept faithful so the numbers stay correct if a
 * model ever does carry rates.
 */
export function calculateCost(model: Model<Api>, usage: Usage): void {
	const rates = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * (rate ?? 0);

	const input = perMillion(usage.input ?? 0, rates.input);
	const output = perMillion(usage.output ?? 0, rates.output);
	const cacheRead = perMillion(usage.cacheRead ?? 0, rates.cacheRead);
	const cacheWrite = perMillion(usage.cacheWrite ?? 0, rates.cacheWrite);

	usage.cost = { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
