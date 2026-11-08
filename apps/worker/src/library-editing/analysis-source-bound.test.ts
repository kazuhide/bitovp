import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
	analysisBudget,
	verifyAnalysisFile,
	verifyAnalysisSourceFile,
} from "./analysis-io";

const files = vi.hoisted(() => ({ stat: vi.fn(), stream: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
	...(await original<typeof import("node:fs/promises")>()),
	stat: files.stat,
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	createReadStream: files.stream,
}));

const bytes = Buffer.from("synthetic streamed source hash evidence");
const digest = createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
	files.stat.mockReset().mockResolvedValue({
		isFile: () => true,
		size: 512 * 1024 ** 2 + 1,
	});
	files.stream.mockReset().mockImplementation(async function* () {
		yield bytes;
	});
});

it.each([
	512 * 1024 ** 2 + 1,
	4 * 1024 ** 3,
])("checks the actual streamed SHA after admitting source metadata of %i bytes", async (size) => {
	files.stat.mockResolvedValue({ isFile: () => true, size });
	await expect(
		verifyAnalysisSourceFile(
			"/owned/source.mp4",
			digest,
			"SOURCE_CHANGED",
			analysisBudget(),
		),
	).resolves.toBeUndefined();
	expect(files.stream).toHaveBeenCalledExactlyOnceWith("/owned/source.mp4");
});
it.each([
	0,
	4 * 1024 ** 3 + 1,
])("rejects out-of-bound source metadata of %i bytes before reading", async (size) => {
	files.stat.mockResolvedValue({ isFile: () => true, size });
	await expect(
		verifyAnalysisSourceFile(
			"/owned/source.mp4",
			digest,
			"SOURCE_CHANGED",
			analysisBudget(),
		),
	).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
	expect(files.stream).not.toHaveBeenCalled();
});
it("retains the smaller auxiliary-file bound", async () => {
	await expect(
		verifyAnalysisFile(
			"/owned/vad.bin",
			digest,
			"VAD_CHANGED",
			analysisBudget(),
		),
	).rejects.toMatchObject({ code: "VAD_CHANGED" });
	expect(files.stream).not.toHaveBeenCalled();
});
it("rejects a changed source hash after streaming", async () => {
	await expect(
		verifyAnalysisSourceFile(
			"/owned/source.mp4",
			"a".repeat(64),
			"SOURCE_CHANGED",
			analysisBudget(),
		),
	).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
	expect(files.stream).toHaveBeenCalledOnce();
});
it("honors cancellation before opening a source stream", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		verifyAnalysisSourceFile(
			"/owned/source.mp4",
			digest,
			"SOURCE_CHANGED",
			analysisBudget(controller.signal),
		),
	).rejects.toMatchObject({ code: "CANCELED" });
	expect(files.stat).not.toHaveBeenCalled();
	expect(files.stream).not.toHaveBeenCalled();
});
