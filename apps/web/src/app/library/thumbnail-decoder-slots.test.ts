import { expect, it } from "vitest";
import { withThumbnailDecoder } from "./thumbnail-decoder-slots";

it("shares two slots across different capture pipelines and removes canceled waiters", async () => {
	let active = 0,
		peak = 0;
	const complete: (() => void)[] = [];
	const capture = () =>
		new Promise<string>((resolve) => {
			active++;
			peak = Math.max(peak, active);
			complete.push(() => {
				active--;
				resolve("still");
			});
		});
	const a = new AbortController(),
		b = new AbortController(),
		canceled = new AbortController(),
		d = new AbortController();
	const one = withThumbnailDecoder(a.signal, capture);
	const two = withThumbnailDecoder(b.signal, capture);
	const skip = withThumbnailDecoder(canceled.signal, capture);
	const four = withThumbnailDecoder(d.signal, capture);
	canceled.abort();
	expect(await skip).toBeNull();
	expect(complete).toHaveLength(2);
	complete.shift()?.();
	await one;
	await Promise.resolve();
	expect(complete).toHaveLength(2);
	while (complete.length) complete.shift()?.();
	await Promise.all([two, four]);
	expect(peak).toBe(2);
	expect(active).toBe(0);
});
