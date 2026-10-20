import type {
	EncodingPlan,
	PlanDrm,
	PlanManifest,
	PlanMuxing,
	PlanOutput,
} from "./schema";

type OutputPlan = Pick<EncodingPlan, "outputs" | "deliveryMirrors">;
type Destination = { outputKey: string; path: string };
export type OutputFile = { destination: Destination; filename: string };
type PlannedOutputFile = OutputFile & { owner: string; path: string };

/** Output keys and names are aliases, not separate storage namespaces. */
function storageIdentity(output: PlanOutput): string {
	// These services have globally unique bucket names, independent of login.
	if (output.kind === "S3") return JSON.stringify(["S3", output.bucket]);
	if (output.kind === "GCS" || output.kind === "GCS_SERVICE_ACCOUNT")
		return JSON.stringify(["GCS", output.bucket]);
	// Other account or host identities resolve from their vault reference.
	return JSON.stringify([
		output.kind,
		output.credentialId,
		"bucket" in output
			? output.bucket
			: "container" in output
				? output.container
				: "",
	]);
}

export function outputFilePath(base: string, filename: string): string {
	const parts: string[] = [];
	for (const part of `${base}/${filename}`.split("/")) {
		if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return parts.join("/");
}

function addresses(plan: OutputPlan, file: OutputFile) {
	const keys = new Set([
		file.destination.outputKey,
		...(plan.deliveryMirrors ?? []).map((mirror) => mirror.outputKey),
	]);
	return plan.outputs
		.filter((output) => keys.has(output.key))
		.map((output) => ({
			storage: storageIdentity(output),
			path: outputFilePath(file.destination.path, file.filename),
		}));
}

/** One writer may reach a physical file through several output aliases. */
export function outputFileKeys(
	plan: OutputPlan,
	file: OutputFile,
): Set<string> {
	return new Set(
		addresses(plan, file).map((address) => JSON.stringify(address)),
	);
}

/** Existing flat names beside this master, including writes through mirrors. */
export function outputFileNamesAtDestination(
	plan: OutputPlan,
	destination: Destination,
	files: OutputFile[],
): Set<string> {
	const target = addresses(plan, { destination, filename: "" });
	const names = new Set<string>();
	for (const file of files)
		for (const address of addresses(plan, file))
			for (const directory of target) {
				if (directory.storage !== address.storage) continue;
				const prefix = directory.path ? `${directory.path}/` : "";
				if (!address.path.startsWith(prefix)) continue;
				const name = address.path.slice(prefix.length);
				if (name && !name.includes("/")) names.add(name);
			}
	return names;
}

/** Dynamic segment names are provider-resolved; reserve only known files. */
function staticNames(muxing: PlanMuxing): string[] {
	const names: string[] = [];
	if ("filename" in muxing) names.push(muxing.filename);
	const literal = (value: string) => {
		if (!/[%{}]/.test(value)) names.push(value);
	};
	if ("initSegmentName" in muxing)
		literal(
			muxing.kind === "CMAF" && muxing.initSegmentNameTemplate
				? muxing.initSegmentNameTemplate
				: muxing.initSegmentName,
		);
	if ("segmentNaming" in muxing)
		literal(
			"segmentNamingTemplate" in muxing && muxing.segmentNamingTemplate
				? muxing.segmentNamingTemplate
				: muxing.segmentNaming,
		);
	return [...new Set(names)];
}

export function staticManifestOutputFiles(plan: {
	manifests: PlanManifest[];
}): PlannedOutputFile[] {
	return plan.manifests.flatMap((manifest, index) => {
		const names =
			manifest.kind === "SMOOTH"
				? [manifest.serverManifestName, manifest.clientManifestName]
				: [manifest.manifestName];
		return names.map((filename) => ({
			destination: manifest.destination,
			filename,
			owner: `master:${manifest.key}:${filename}`,
			path: `manifests[${index}]`,
		}));
	});
}

export function staticMuxingOutputFiles(plan: {
	muxings: PlanMuxing[];
	drm?: PlanDrm[];
	qc?: { only?: boolean };
}): PlannedOutputFile[] {
	if (plan.qc?.only) return [];
	return plan.muxings.flatMap((muxing, index) => {
		const destinations = [
			...(muxing.destination
				? [
						{
							destination: muxing.destination,
							owner: `muxing:${muxing.key}`,
							path: `muxings[${index}].destination`,
						},
					]
				: []),
			...(plan.drm ?? []).flatMap((drm, drmIndex) =>
				drm.muxingKey === muxing.key
					? [
							{
								destination: drm.destination,
								owner: `drm:${drm.key}`,
								path: `drm[${drmIndex}].destination`,
							},
						]
					: [],
			),
		];
		return destinations.flatMap((destination) =>
			staticNames(muxing).map((filename) => ({ ...destination, filename })),
		);
	});
}
