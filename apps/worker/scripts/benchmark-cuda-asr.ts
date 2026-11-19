import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { hashEditingEvidence } from "@bitovp/core";
import {
	analysisBudget,
	boundedInteger,
	verifyAnalysisFile,
} from "../src/library-editing/analysis-io";
import {
	type TranscriptionInput,
	transcribeLocalAudio,
} from "../src/library-editing/transcription";

const { values } = parseArgs({
	options: {
		"cuda-cli": { type: "string" },
		"cuda-sha256": { type: "string" },
		media: { type: "string" },
		"media-sha256": { type: "string" },
		model: { type: "string" },
		"model-sha256": { type: "string" },
		"duration-us": { type: "string" },
		"offset-us": { type: "string", default: "0" },
		language: { type: "string", default: "ja" },
		pairs: { type: "string", default: "3" },
		"private-results": { type: "string" },
	},
});
const required = (key: keyof typeof values): string => {
	const value = values[key];
	if (typeof value !== "string" || !value) throw new Error(`Missing --${key}`);
	return value;
};
const { language } = values;
if (language !== "ja" && language !== "en" && language !== "auto")
	throw new Error("Use ja, en or auto for --language");
const cuda = {
	binaryPath: required("cuda-cli"),
	binarySha256: required("cuda-sha256"),
};
const input: TranscriptionInput = {
	sourcePath: required("media"),
	mediaSha256: required("media-sha256"),
	model: { path: required("model"), sha256: required("model-sha256") },
	whisperPath: cuda.binaryPath,
	language,
	durationUs: Number(required("duration-us")),
	sourceStartUs: Number(values["offset-us"]),
};
const pairs = boundedInteger(Number(values.pairs), 1, Number.MAX_SAFE_INTEGER);
await verifyAnalysisFile(
	cuda.binaryPath,
	cuda.binarySha256,
	"ASR_CUDA_BINARY_CHANGED",
	analysisBudget(),
);

async function run(useCuda: boolean) {
	const started = performance.now();
	const result = await transcribeLocalAudio({
		...input,
		...(useCuda ? { cuda } : {}),
	});
	const elapsedMs = performance.now() - started;
	if (useCuda && !result.cudaExecution?.device)
		throw new Error("The benchmark needs a non-silent interval");
	return { result, elapsedMs };
}

const observations = [];
for (let index = 0; index < pairs; index++) {
	const cpuFirst = index % 2 === 0;
	const first = await run(!cpuFirst);
	const second = await run(cpuFirst);
	observations.push({
		order: cpuFirst ? "cpu-cuda" : "cuda-cpu",
		cpu: cpuFirst ? first : second,
		cuda: cpuFirst ? second : first,
	});
}
const witness = ({ result, elapsedMs }: Awaited<ReturnType<typeof run>>) => ({
	elapsedMs,
	language: result.language,
	qualityPolicyFingerprint: result.qualityPolicyFingerprint,
	segmentCount: result.segments.length,
	admittedTranscriptSha256: hashEditingEvidence(result.segments),
	speechIntervalsSha256: hashEditingEvidence(result.speechIntervals),
	cudaExecution: result.cudaExecution,
});
if (values["private-results"])
	await writeFile(
		values["private-results"],
		JSON.stringify(observations, null, 2),
		{ flag: "wx", mode: 0o600 },
	);
const median = (values: number[]) => {
	const sorted = values.toSorted((a, b) => a - b);
	const lower = sorted[Math.floor((values.length - 1) / 2)];
	const upper = sorted[Math.floor(values.length / 2)];
	if (lower === undefined || upper === undefined)
		throw new Error("Missing benchmark observations");
	return (lower + upper) / 2;
};
const cpuMedianMs = median(observations.map(({ cpu }) => cpu.elapsedMs));
const cudaMedianMs = median(observations.map(({ cuda }) => cuda.elapsedMs));
console.log(
	JSON.stringify(
		{
			mediaSha256: input.mediaSha256,
			modelSha256: input.model.sha256,
			binarySha256: cuda.binarySha256,
			durationUs: input.durationUs,
			offsetUs: input.sourceStartUs,
			cpuMedianMs,
			cudaMedianMs,
			speedup: cpuMedianMs / cudaMedianMs,
			samples: observations.map(({ order, cpu, cuda }) => ({
				order,
				cpu: witness(cpu),
				cuda: witness(cuda),
			})),
		},
		null,
		2,
	),
);
