import { describe, expect, it, vi } from "vitest";
import { adoptOrCreateStamped } from "./ops/shared";

function args(lookup: () => Promise<string | undefined>) {
	return {
		label: "encoding",
		stamp: {
			jobId: "owned-channel",
			currentStep: () => "encoding",
			adoptWindow: () => true,
			allowCreate: () => false,
		},
		lookup,
		create: vi.fn(async () => "unwanted-new"),
		auditAdopt: vi.fn(async () => {}),
	};
}
describe("cancelled startup response-loss adoption", () => {
	it("adopts the exact pending CREATE without another POST", async () => {
		const a = args(async () => "original-encoding");
		expect(await adoptOrCreateStamped(a)).toBe("original-encoding");
		expect(a.create).not.toHaveBeenCalled();
	});
	it("keeps an empty scan unresolved instead of creating", async () => {
		const a = args(async () => undefined);
		await expect(adoptOrCreateStamped(a)).rejects.toThrow("remains unresolved");
		expect(a.create).not.toHaveBeenCalled();
	});
	it("does not create when lookup fails", async () => {
		const a = args(async () => {
			throw new Error("lookup unavailable");
		});
		await expect(adoptOrCreateStamped(a)).rejects.toThrow("lookup unavailable");
		expect(a.create).not.toHaveBeenCalled();
	});
});
