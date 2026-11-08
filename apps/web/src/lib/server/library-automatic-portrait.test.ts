import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAutomaticPortrait } from "./library-automatic-portrait";

const context = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("SERVER_BOUNDARY_REACHED");
	}),
);
vi.mock("./context", () => ({ getServerContext: context }));
const id = "11111111-1111-4111-8111-111111111111";
const input = {
	contentId: id,
	mediaVersionId: id,
	analysisRevisionId: id,
	targetDurationFrames: 900,
	requestKey: id,
};

describe("automatic portrait request boundary", () => {
	it.each([
		0,
		1,
		29,
		5401,
		90.5,
		Number.POSITIVE_INFINITY,
	])("rejects invalid frame length %s before reading tenant data", async (targetDurationFrames) => {
		context.mockClear();
		await expect(
			createAutomaticPortrait({ ...input, targetDurationFrames }, null),
		).rejects.toBeInstanceOf(z.ZodError);
		expect(context).not.toHaveBeenCalled();
	});
	it("does not accept client-supplied source proof or policy acceptance", async () => {
		context.mockClear();
		await expect(
			createAutomaticPortrait({ ...input, binding: { kind: "PROVEN" } }, null),
		).rejects.toBeInstanceOf(z.ZodError);
		expect(context).not.toHaveBeenCalled();
	});
	it("requires tenant resource identifiers and a stable UUID intent key", async () => {
		context.mockClear();
		await expect(
			createAutomaticPortrait({ ...input, requestKey: "retry" }, null),
		).rejects.toBeInstanceOf(z.ZodError);
		expect(context).not.toHaveBeenCalled();
	});
	it.each([
		30, 5400,
	])("accepts supported bound %s and then enters the server-owned path", async (targetDurationFrames) => {
		await expect(
			createAutomaticPortrait({ ...input, targetDurationFrames }, null),
		).rejects.toThrow("SERVER_BOUNDARY_REACHED");
	});
});
