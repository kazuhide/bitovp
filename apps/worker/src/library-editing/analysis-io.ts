import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import asrModelProfiles from "../../native/asr-model-profiles.json" with {
	type: "json",
};
import { MediaOperationError } from "./process";
import { MAX_EDITING_SOURCE_BYTES } from "./source-limits";

export const MAX_ANALYSIS_DURATION_US = 180_000_000;
const MAX_ANALYSIS_FILE_BYTES = 512 * 1024 * 1024;
export const validDigest = (value: string) => /^[a-f0-9]{64}$/.test(value);
export function boundedInteger(value: number, min: number, max: number) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new RangeError("Invalid local analysis bound");
	return value;
}
export function analysisBudget(signal?: AbortSignal, timeoutMs = 180_000) {
	boundedInteger(timeoutMs, 1, 30 * 60_000);
	const deadline = Date.now() + timeoutMs;
	const check = () => {
		if (signal?.aborted) throw new MediaOperationError("CANCELED");
		if (Date.now() >= deadline) throw new MediaOperationError("TIMED_OUT");
	};
	return {
		signal,
		check,
		remaining: () => {
			check();
			return deadline - Date.now();
		},
	};
}
export type AnalysisBudget = ReturnType<typeof analysisBudget>;

async function verifyBoundedFile(
	path: string,
	expected: string,
	code: string,
	budget: AnalysisBudget,
	maxBytes: number,
	expectedBytes?: number,
) {
	budget.check();
	if (!isAbsolute(path) || !validDigest(expected))
		throw new RangeError("Expected absolute local path and SHA-256");
	const facts = await stat(path);
	if (
		!facts.isFile() ||
		facts.size < 1 ||
		facts.size > maxBytes ||
		(expectedBytes !== undefined && facts.size !== expectedBytes)
	)
		throw new MediaOperationError(code);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		budget.check();
		hash.update(chunk);
	}
	budget.check();
	if (hash.digest("hex") !== expected) throw new MediaOperationError(code);
}

/** Hash actual owned bytes before trusting a cache identity supplied by a job. */
export async function verifyAnalysisFile(
	path: string,
	expected: string,
	code: string,
	budget: AnalysisBudget,
) {
	return verifyBoundedFile(
		path,
		expected,
		code,
		budget,
		MAX_ANALYSIS_FILE_BYTES,
	);
}

/** Full prepared sources share preparation's limit; auxiliary files keep their smaller bound. */
export async function verifyAnalysisSourceFile(
	path: string,
	expected: string,
	code: string,
	budget: AnalysisBudget,
) {
	return verifyBoundedFile(
		path,
		expected,
		code,
		budget,
		MAX_EDITING_SOURCE_BYTES,
	);
}

/** Only registered ASR weights may exceed the ordinary auxiliary-file bound. */
export async function verifyAsrModelFile(
	path: string,
	expected: string,
	code: string,
	budget: AnalysisBudget,
) {
	const profile = Object.values(asrModelProfiles).find(
		(candidate) => candidate.sha256 === expected,
	);
	return verifyBoundedFile(
		path,
		expected,
		code,
		budget,
		profile?.size ?? MAX_ANALYSIS_FILE_BYTES,
		profile?.size,
	);
}
export async function analysisScratch(prefix: string) {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	await chmod(directory, 0o700);
	return directory;
}
