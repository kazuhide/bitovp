import {
	outputFileKeys,
	outputStorageKeys,
	staticManifestOutputFiles,
	staticMuxingOutputFiles,
} from "./output-files";
import type { EncodingPlan, EncodingSupplement } from "./schema";
import type { PlanIssue } from "./validate";

function inputExtension(item: EncodingSupplement) {
	switch (item.kind) {
		case "SIDECAR":
		case "WEBVTT_SIDECAR":
			return ".vtt";
		case "SCC_CONVERSION":
		case "CEA_SCC":
			return ".scc";
		case "CEA_SRT":
			return ".srt";
		default:
			return;
	}
}

export function validateEncodingSupplements(
	plan: EncodingPlan,
	resolvedStorageKeys?: ReadonlyMap<string, string>,
): PlanIssue[] {
	if (!plan.supplements?.length) return [];
	const issues: PlanIssue[] = [];
	const videoCodecs = new Set(["H264", "H265", "VP9", "AV1"]);
	const keys = new Set<string>();
	const singletons = new Set<string>();
	const renditions = new Map(
		plan.renditions.map((rendition) => [rendition.key, rendition]),
	);
	const inputs = new Set(plan.inputs.map((input) => input.key));
	const outputs = new Map(
		plan.outputs.map((output) => [output.key, output.kind]),
	);
	const firstEncoding = plan.encodings?.[0]?.key;
	const encodings = new Set(
		plan.encodings?.map((encoding) => encoding.key) ?? [],
	);
	const written = new Set(
		[
			...staticMuxingOutputFiles(plan),
			...staticManifestOutputFiles(plan),
		].flatMap((file) => [...outputFileKeys(plan, file, resolvedStorageKeys)]),
	);
	const copiedInput = plan.renditions.find(
		(rendition) => rendition.codec === "AUDIO_PASSTHROUGH",
	)?.ingestKey;
	const capturedInput = plan.ingest.find(
		(stream) => stream.key === copiedInput,
	)?.inputKey;
	for (const [index, item] of plan.supplements.entries()) {
		const problem = (code: string, message: string, field?: string) => {
			issues.push({
				code: `PLAN_SUPPLEMENT_${code}`,
				level: "error",
				path: `supplements.${index}${field ? `.${field}` : ""}`,
				message,
			});
		};
		if (plan.qc?.only)
			problem(
				"QC_ONLY",
				"Supplementary output and provider QC require a normal VOD job",
			);
		if (keys.has(item.key))
			problem("KEY", "Supplement keys must be unique", "key");
		keys.add(item.key);

		const rendition =
			"renditionKey" in item ? renditions.get(item.renditionKey) : undefined;
		if (
			"renditionKey" in item &&
			(!rendition || !videoCodecs.has(rendition.codec))
		)
			problem("VIDEO", "Choose a video rendition", "renditionKey");
		if (
			"encodingKey" in item &&
			item.encodingKey !== undefined &&
			!encodings.has(item.encodingKey)
		)
			problem("ENCODING", "Choose a declared encoding", "encodingKey");

		if ("inputKey" in item) {
			if (!inputs.has(item.inputKey) || item.inputKey === capturedInput)
				problem(
					"INPUT",
					"Choose a plan input with a reusable file path",
					"inputKey",
				);
			const extension = inputExtension(item);
			if (extension && !item.inputPath.toLowerCase().endsWith(extension))
				problem(
					"INPUT_PATH",
					`The input path must end in ${extension}`,
					"inputPath",
				);
			if (!item.inputPath.split("/").at(-1))
				problem("INPUT_PATH", "The input path must name a file", "inputPath");
		}
		if (item.kind === "BURN_IN_DVBSUB") {
			const ingest = plan.ingest.find(
				(stream) => stream.key === item.ingestKey,
			);
			if (
				ingest?.selectionMode !== "SUBTITLE_RELATIVE" ||
				(ingest.encodingKey ?? firstEncoding) !==
					(rendition?.encodingKey ?? firstEncoding)
			)
				problem(
					"INGEST",
					"Choose a subtitle-relative ingest stream in the same encoding",
					"ingestKey",
				);
		}

		let singleton: string | undefined;
		if (item.kind === "PSNR") singleton = `${item.renditionKey}:psnr`;
		if (item.kind === "BURN_IN_ASSA" || item.kind === "BURN_IN_DVBSUB")
			singleton = `${item.renditionKey}:burn-in`;
		if (item.kind === "CEA_SCC" || item.kind === "CEA_SRT")
			singleton = `${item.renditionKey}:cea:${item.kind === "CEA_SRT" ? item.ccChannel : "CC1"}`;
		if (item.kind === "SCTE35_TRIGGER")
			singleton = `trigger:${item.encodingKey ?? firstEncoding ?? ""}:${item.base64EncodedMetadata}`;
		if (singleton) {
			if (singletons.has(singleton))
				problem("DUPLICATE", "This setting is already present on its target");
			singletons.add(singleton);
		}
		if (singleton?.endsWith(":burn-in") && rendition?.burnInSrt)
			problem("DUPLICATE", "The rendition already declares a burn-in subtitle");
		if ("destination" in item) {
			const kind = outputs.get(item.destination.outputKey);
			if (
				!kind ||
				kind === "AKAMAI_MSL" ||
				kind === "LIVE_MEDIA_INGEST" ||
				kind === "MOQ"
			)
				problem("DESTINATION", "Choose a file output", "destination");
			if (
				kind &&
				outputStorageKeys(plan, item.destination.outputKey, resolvedStorageKeys)
					.size !==
					1 + (plan.deliveryMirrors?.length ?? 0)
			)
				problem(
					"DESTINATION_MIRROR",
					"Choose distinct storage destinations for the supplement and its mirrors",
					"destination",
				);
			const filename =
				"filename" in item ? item.filename : item.inputPath.split("/").at(-1);
			if (filename) {
				const files = outputFileKeys(
					plan,
					{ destination: item.destination, filename },
					resolvedStorageKeys,
				);
				if ([...files].some((file) => written.has(file)))
					problem(
						"OUTPUT_COLLISION",
						"This file is already written by this plan. Choose a different name or directory.",
						"destination",
					);
				for (const file of files) written.add(file);
			}
		}
	}
	return issues;
}
