import type { StepLogEntry } from "@bitovp/core";
import { expect, it, vi } from "vitest";
import { fakeSdk } from "../orchestrator/fake-sdk";
import { journalLostEncodings } from "./lost-encodings";

const entries = [
	{ kind: "CREATE_ENCODING", resourceId: "late-id" },
] as StepLogEntry[];
it("journals a late CREATE before stopping it after reset", async () => {
	const order: string[] = [];
	const journal = vi.fn(async () => {
		order.push("durable");
		return true;
	});
	const sdk = fakeSdk({
		stopEncoding: vi.fn(async () => {
			order.push("stop");
		}),
	});
	await journalLostEncodings(
		journal,
		"encodingJob:deleted",
		"account",
		entries,
		sdk,
	);
	expect(order).toEqual(["durable", "stop"]);
	expect(journal).toHaveBeenCalledWith(
		"encodingJob:deleted",
		"late-id",
		"account",
	);
});
it("does not stop another worker's encoding on ordinary lease loss", async () => {
	const sdk = fakeSdk({ stopEncoding: vi.fn() });
	await journalLostEncodings(
		async () => false,
		"liveChannel:retained",
		"account",
		entries,
		sdk,
	);
	expect(sdk.stopEncoding).not.toHaveBeenCalled();
});
it("does not issue a stop before failed durable ownership transfer", async () => {
	const sdk = fakeSdk({ stopEncoding: vi.fn() });
	await expect(
		journalLostEncodings(
			async () => {
				throw new Error("DB unavailable");
			},
			"liveChannel:deleted",
			"account",
			entries,
			sdk,
		),
	).rejects.toThrow("DB unavailable");
	expect(sdk.stopEncoding).not.toHaveBeenCalled();
});
