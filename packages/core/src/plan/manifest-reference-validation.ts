import { outputFileKeys } from "./output-files";
import type { PlanIssue } from "./validate";

type OutputPlan = Parameters<typeof outputFileKeys>[0];
type Destination = { outputKey: string; path: string };
export type PlaylistWriter = {
	destination: Destination;
	filename: string;
	owner: string;
	path: string;
};

/** A relative media URL must resolve on every storage target serving its manifest. */
export function manifestMediaReachable(
	plan: OutputPlan,
	media: Destination | undefined,
	manifest: Destination,
): boolean {
	if (!media) return false;
	const filename = "__media_reference_probe__.bin";
	const actual = new Set(
		outputFileKeys(plan, { destination: media, filename }),
	);
	const served = outputFileKeys(plan, {
		destination: { ...manifest, path: media.path },
		filename,
	});
	return served.size > 0 && [...served].every((key) => actual.has(key));
}

/** Reserve owners before deduplication, across aliases and delivery mirrors. */
export function additionalPlaylistWriterIssues(
	plan: OutputPlan,
	existing: PlaylistWriter[],
	additional: PlaylistWriter[],
): PlanIssue[] {
	const owners = new Map<string, Set<string>>();
	const reserve = (writer: PlaylistWriter) => {
		for (const key of outputFileKeys(plan, writer)) {
			const values = owners.get(key) ?? new Set<string>();
			values.add(writer.owner);
			owners.set(key, values);
		}
	};
	for (const writer of existing) reserve(writer);
	const issues: PlanIssue[] = [];
	for (const writer of additional) {
		const collisions = new Set(
			[...outputFileKeys(plan, writer)]
				.flatMap((key) => [...(owners.get(key) ?? [])])
				.filter((owner) => owner !== writer.owner),
		);
		if (collisions.size)
			issues.push({
				code: "PLAN_MANIFEST_URI_COLLISION",
				level: "error",
				path: writer.path,
				message: `Child playlist "${writer.filename}" is written by ${writer.owner} and ${[...collisions].join(", ")}. Use distinct playlist filenames or output folders.`,
			});
		reserve(writer);
	}
	return issues;
}
