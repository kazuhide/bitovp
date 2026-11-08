import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
	type MediaTaskCreateInput,
	type MediaTaskIdentity,
	mediaTaskCacheKey,
} from "@bitovp/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
	analysisBudget,
	verifyAnalysisFile,
	verifyAsrModelFile,
} from "./analysis-io";
import { transcriptionCacheKey } from "./transcription";

const files = vi.hoisted(() => ({ stat: vi.fn(), stream: vi.fn() }));
vi.mock("node:fs", async (original) => ({
	...(await original<object>()),
	createReadStream: files.stream,
}));
vi.mock("node:fs/promises", async (original) => ({
	...(await original<object>()),
	stat: files.stat,
}));
const turboSha =
	"394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
const smallSha =
	"1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const turboSize = 574041195;
const bytes = Buffer.from("synthetic model bytes, never real model weights");
const customSha = createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
	files.stat
		.mockReset()
		.mockResolvedValue({ isFile: () => true, size: bytes.length });
	files.stream.mockReset().mockImplementation(() => Readable.from([bytes]));
});

it("streams a registered large ASR model but still rejects bytes that do not match its SHA", async () => {
	files.stat.mockResolvedValue({ isFile: () => true, size: turboSize });
	await expect(
		verifyAsrModelFile(
			"/owned/turbo.bin",
			turboSha,
			"MODEL_CHANGED",
			analysisBudget(),
		),
	).rejects.toMatchObject({ code: "MODEL_CHANGED" });
	expect(files.stream).toHaveBeenCalledExactlyOnceWith("/owned/turbo.bin");
});

it.each([
	"SOURCE_CHANGED",
	"VAD_MODEL_CHANGED",
	"TRACKING_SOURCE_CHANGED",
])("retains the generic 512 MiB limit for %s even with the registered model digest", async (code) => {
	files.stat.mockResolvedValue({ isFile: () => true, size: turboSize });
	await expect(
		verifyAnalysisFile("/owned/other.bin", turboSha, code, analysisBudget()),
	).rejects.toMatchObject({ code });
	expect(files.stream).not.toHaveBeenCalled();
});

it.each([
	{ sha: customSha, size: turboSize },
	{ sha: turboSha, size: turboSize + 1 },
	{ sha: turboSha, size: turboSize - 1 },
	{ sha: turboSha, size: bytes.length },
])("refuses unregistered or wrong-size large model identities before reading bytes: $size/$sha", async ({
	sha,
	size,
}) => {
	files.stat.mockResolvedValue({ isFile: () => true, size });
	await expect(
		verifyAsrModelFile(
			"/owned/model.bin",
			sha,
			"MODEL_CHANGED",
			analysisBudget(),
		),
	).rejects.toMatchObject({ code: "MODEL_CHANGED" });
	expect(files.stream).not.toHaveBeenCalled();
});

it("keeps custom models below the legacy limit working and verifies their actual streamed SHA", async () => {
	await expect(
		verifyAsrModelFile(
			"/owned/custom.bin",
			customSha,
			"MODEL_CHANGED",
			analysisBudget(),
		),
	).resolves.toBeUndefined();
	await expect(
		verifyAsrModelFile(
			"/owned/custom.bin",
			"a".repeat(64),
			"MODEL_CHANGED",
			analysisBudget(),
		),
	).rejects.toMatchObject({ code: "MODEL_CHANGED" });
	expect(files.stream).toHaveBeenCalledTimes(2);
});

it("preserves cancellation before any model I/O", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		verifyAsrModelFile(
			"/owned/turbo.bin",
			turboSha,
			"MODEL_CHANGED",
			analysisBudget(controller.signal),
		),
	).rejects.toMatchObject({ code: "CANCELED" });
	expect(files.stat).not.toHaveBeenCalled();
	expect(files.stream).not.toHaveBeenCalled();
});

it("keeps small and turbo transcription and task caches separate for identical media and intent", () => {
	const transcription = {
		mediaSha256: "a".repeat(64),
		language: "en",
		durationUs: 30_000_000,
	};
	expect(
		transcriptionCacheKey({ ...transcription, modelSha256: turboSha }),
	).not.toBe(
		transcriptionCacheKey({ ...transcription, modelSha256: smallSha }),
	);
	const input: MediaTaskCreateInput = {
		kind: "TRANSCRIBE",
		requestKey: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "22222222-2222-4222-8222-222222222222",
		parameters: { language: "en", durationUs: 30_000_000, sourceStartUs: 0 },
	};
	const identity: MediaTaskIdentity = {
		organizationId: "33333333-3333-4333-8333-333333333333",
		mediaSha256: transcription.mediaSha256,
		modelSha256: smallSha,
		analysisDocumentHash: null,
		analysisRawHash: null,
		timeMapHash: null,
	};
	expect(
		mediaTaskCacheKey(input, { ...identity, modelSha256: turboSha }),
	).not.toBe(mediaTaskCacheKey(input, identity));
	expect(
		mediaTaskCacheKey(
			{ ...input, requestKey: "44444444-4444-4444-8444-444444444444" },
			identity,
		),
	).toBe(mediaTaskCacheKey(input, identity));
});
