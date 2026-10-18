import { describe, expect, it, vi } from "vitest";
import { projecting, projectingMany, projectSelected } from "./test-helpers";

/**
 * The helper is itself a test instrument, so it gets the treatment an
 * instrument deserves: the cases that matter are the ones where getting it
 * wrong would make it silently permissive again.
 */
describe("projectSelected", () => {
	const ROW = { id: "a", plan: { x: 1 }, name: "job", labels: ["l"] };

	it("keeps only the requested keys", () => {
		expect(projectSelected(ROW, { id: true, name: true })).toEqual({
			id: "a",
			name: "job",
		});
	});

	it("drops a key the caller did NOT request — the whole point", () => {
		const out = projectSelected(ROW, { id: true });
		expect("name" in out).toBe(false);
		// Not merely undefined: absent, as Prisma returns it.
		expect(Object.keys(out)).toEqual(["id"]);
	});

	it("returns the FULL row when there is no select", () => {
		// Prisma does this, and a double that projected an absent select to {}
		// would break every existing test that omits it.
		expect(projectSelected(ROW, undefined)).toEqual(ROW);
	});

	it("treats `false` as omitted, like Prisma", () => {
		expect(projectSelected(ROW, { id: true, name: false })).toEqual({
			id: "a",
		});
	});
});

describe("projecting / projectingMany", () => {
	it("projects a resolver's row and passes the args through", async () => {
		const resolve = vi.fn(async () => ({ id: "a", secret: "s", name: "n" }));
		const fake = projecting(resolve);
		await expect(fake({ select: { id: true, name: true } })).resolves.toEqual({
			id: "a",
			name: "n",
		});
		expect(resolve).toHaveBeenCalledWith({ select: { id: true, name: true } });
	});

	it("passes null through — a not-found row is not an empty row", async () => {
		const fake = projecting(async () => null);
		await expect(fake({ select: { id: true } })).resolves.toBeNull();
	});

	it("tolerates being called with no args at all", async () => {
		const fake = projecting(async () => ({ id: "a" }));
		await expect(fake()).resolves.toEqual({ id: "a" });
	});

	it("projects EVERY row of a list, not just the first", async () => {
		const fake = projectingMany(async () => [
			{ id: "a", stableCount: 1 },
			{ id: "b", stableCount: 2 },
		]);
		await expect(fake({ select: { id: true } })).resolves.toEqual([
			{ id: "a" },
			{ id: "b" },
		]);
	});
});
