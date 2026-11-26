import { describe, expect, it, vi } from "vitest";
import { fakeSdk } from "../orchestrator/fake-sdk";
import { withMoqTaskStatus } from "./moq-task-status";

describe("MoQ run status port", () => {
	it("projects Task metadata without changing the underlying legacy SDK", async () => {
		const task = {
			status: "RUNNING",
			progress: 0,
			messages: ["private prose"],
		};
		const sdk = fakeSdk({ getEncodingStatus: vi.fn(async () => task) });
		const moq = withMoqTaskStatus(sdk);
		expect(await moq.getEncodingStatus("encoding")).toEqual({
			status: "RUNNING",
			progress: 0,
		});
		expect(await sdk.getEncodingStatus("legacy-encoding")).toEqual(task);
	});
	it.each([
		"invalid-status",
		"rejected-read",
	])("replaces %s with a fixed safe error without retaining its cause", async (kind) => {
		const text = "authToken=publisher-secret moqt://relay.example/private";
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(async () => {
				if (kind === "rejected-read") throw new Error(text);
				return { status: text, messages: [text] };
			}),
		});
		const error = await withMoqTaskStatus(sdk)
			.getEncodingStatus("encoding")
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "MoQ encoding status unavailable" });
		expect((error as Error).cause).toBeUndefined();
		expect(String(error)).not.toContain(text);
	});
});
