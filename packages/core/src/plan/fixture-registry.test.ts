import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_FIXTURES } from "../live/fixtures";
import { VOD_FIXTURES } from "./fixtures";

const vodDir = join(__dirname, "__fixtures__");
const liveDir = join(__dirname, "..", "live", "__fixtures__");

const plansIn = (dir: string): string[] =>
	readdirSync(dir)
		.filter((f) => f.endsWith(".plan.json"))
		.map((f) => f.replace(/\.plan\.json$/, ""))
		.sort();

describe("fixture registry ↔ directory", () => {
	it("every VOD plan fixture on disk is compiler-pinned", () => {
		expect([...VOD_FIXTURES].sort()).toEqual(plansIn(vodDir));
	});

	it("every LIVE plan fixture on disk is compiler-pinned", () => {
		expect([...LIVE_FIXTURES].sort()).toEqual(plansIn(liveDir));
	});

	it("every plan fixture has the ops golden its deep-equal compares against", () => {
		for (const [dir, names] of [
			[vodDir, VOD_FIXTURES],
			[liveDir, LIVE_FIXTURES],
		] as const) {
			const present = new Set(readdirSync(dir));
			for (const name of names) {
				expect(
					present.has(`${name}.ops.json`),
					`${name}.ops.json is missing`,
				).toBe(true);
			}
		}
	});

	it("retains the complete compiler fixture corpus", () => {
		expect(plansIn(vodDir).length).toBe(72);
		expect(plansIn(liveDir).length).toBe(15);
		expect(VOD_FIXTURES.length + LIVE_FIXTURES.length).toBe(87);
	});
});
