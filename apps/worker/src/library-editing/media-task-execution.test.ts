import {
	AutomaticBindingError,
	type EditingAnalysisBinding,
	mediaTaskEnvelopeSchema,
} from "@bitovp/core";
import type { AppTransactionClient, LibraryMediaTask } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMediaTaskEvidence } from "./media-task-execution";
import { MediaOperationError } from "./process";

const shared = vi.hoisted(() => {
	class EvidenceError extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	}
	return { verify: vi.fn(), EvidenceError };
});
vi.mock("@bitovp/db", () => ({
	verifyLibraryMediaTaskEvidence: shared.verify,
	LibraryMediaTaskEvidenceError: shared.EvidenceError,
	// Historical imports remain available for the pre-extraction RED run.
	getPreparedNormalizationReceipt: vi.fn(),
	LibraryNormalizationClockError: class extends Error {},
}));
beforeEach(() => {
	shared.verify.mockReset();
});

describe("legacy worker source-verification facade", () => {
	it("delegates exact arguments to the locking DB entry and preserves the result reference", async () => {
		const tx = {} as AppTransactionClient,
			task = {} as LibraryMediaTask,
			binding = {} as EditingAnalysisBinding,
			result = { synthetic: "returned shared evidence" };
		shared.verify.mockResolvedValue(result);
		expect(await verifyMediaTaskEvidence(tx, task, binding)).toBe(result);
		expect(shared.verify).toHaveBeenCalledExactlyOnceWith(tx, task, binding);
	});
	it.each([
		"TASK_INTENT_INVALID",
		"MEDIA_NOT_READY",
		"SOURCE_CHANGED",
		"NORMALIZATION_EVIDENCE_UNVERIFIED",
	])("restores the old worker error class for shared %s", async (code) => {
		shared.verify.mockRejectedValue(new shared.EvidenceError(code));
		let caught: unknown;
		try {
			await verifyMediaTaskEvidence(
				{} as AppTransactionClient,
				{} as LibraryMediaTask,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(MediaOperationError);
		expect(caught).toMatchObject({
			code,
			message: code,
			name: "MediaOperationError",
		});
		expect(caught).not.toHaveProperty("cause");
	});
	it("passes AutomaticBindingError, ZodError and foreign failures through as the same object", async () => {
		let schemaFailure: unknown;
		try {
			mediaTaskEnvelopeSchema.parse({});
		} catch (error) {
			schemaFailure = error;
		}
		for (const failure of [
			new AutomaticBindingError(),
			schemaFailure,
			Object.assign(new Error("SYNTHETIC_DRIVER_ERROR"), {
				code: "SOURCE_CHANGED",
			}),
			new MediaOperationError("LEASE_LOST"),
		]) {
			shared.verify.mockRejectedValueOnce(failure);
			await expect(
				verifyMediaTaskEvidence(
					{} as AppTransactionClient,
					{} as LibraryMediaTask,
				),
			).rejects.toBe(failure);
		}
	});
});
