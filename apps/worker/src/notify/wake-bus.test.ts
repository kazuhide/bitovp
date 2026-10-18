import { describe, expect, it } from "vitest";
import { createWakeBus } from "./wake-bus";

/**
 *  PR3 / #16: a signal for an id the sleeper cares about cuts the
 * sleep short; foreign signals do not; with no signal the timer fires — the
 * fixed-interval poll is the floor, never regressed.
 */

const sleepMs = () => new Promise((r) => setTimeout(r, 5));

describe("createWakeBus", () => {
	it("a matching signal wakes the sleeper early", async () => {
		const bus = createWakeBus();
		const started = Date.now();
		const parked = bus.sleep(5_000, (id) => id === "enc-1");
		await sleepMs();
		bus.signal("enc-1");
		await parked;
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(bus.size()).toBe(0);
	});

	it("a FOREIGN signal does not wake it; the timer still fires", async () => {
		const bus = createWakeBus();
		const started = Date.now();
		const parked = bus.sleep(50, (id) => id === "enc-1");
		bus.signal("enc-OTHER");
		await parked;
		// Woken by the 50ms timer, not the foreign signal.
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
		expect(bus.size()).toBe(0);
	});

	it("one signal wakes EVERY interested sleeper (two jobs, one encoding)", async () => {
		const bus = createWakeBus();
		const a = bus.sleep(5_000, () => true);
		const b = bus.sleep(5_000, () => true);
		await sleepMs();
		expect(bus.size()).toBe(2);
		bus.signal("enc-1");
		await Promise.all([a, b]);
		expect(bus.size()).toBe(0);
	});

	it("the interest getter is evaluated at SIGNAL time, not sleep time", async () => {
		// The encoding id does not exist until CREATE_ENCODING runs — the
		// executor's getter must be read late (the processor seam's contract).
		const bus = createWakeBus();
		const ids: string[] = [];
		const parked = bus.sleep(5_000, (id) => ids.includes(id));
		await sleepMs();
		bus.signal("enc-1"); // not yet interesting
		// STILL parked — without this line the test pinned nothing beyond the
		// foreign-signal case (review-186 N5/M10: a bus that wakes everyone
		// satisfied await+size(0) here while test 2 alone went red).
		expect(bus.size()).toBe(1);
		ids.push("enc-1");
		bus.signal("enc-1"); // now it is
		await parked;
		expect(bus.size()).toBe(0);
	});
});
