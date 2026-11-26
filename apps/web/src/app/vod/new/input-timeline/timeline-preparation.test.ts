import { expect, it } from "vitest";
import { credentialId, taskId, timeline } from "./test-fixtures";
import { timelinePreparationKey } from "./timeline-preparation";

const sources = [
	{
		key: "a",
		inputKey: "main",
		kind: "S3" as const,
		credentialId,
		bucket: "input",
		path: "a.mp4",
	},
];
const output = { credentialId, bucket: "output", prefix: "prepared/" };
it("invalidates on trim, source addressing, probe version and output changes", () => {
	const source = sources[0];
	if (!source) throw new Error("Expected source fixture");
	const doc = timeline();
	const key = timelinePreparationKey(doc, sources, output, taskId);
	expect(
		timelinePreparationKey(
			{
				...doc,
				clips: doc.clips.map((clip, i) =>
					i ? clip : { ...clip, inMs: clip.inMs + 100 },
				),
			},
			sources,
			output,
			taskId,
		),
	).not.toBe(key);
	expect(
		timelinePreparationKey(
			doc,
			[{ ...source, path: "changed.mp4" }],
			output,
			taskId,
		),
	).not.toBe(key);
	expect(
		timelinePreparationKey(
			doc,
			sources,
			{ ...output, bucket: "other" },
			taskId,
		),
	).not.toBe(key);
	expect(timelinePreparationKey(doc, sources, output, "new-probe")).not.toBe(
		key,
	);
});
