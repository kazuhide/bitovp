import {
	normalizeVodInputTimelineDocument,
	type VodInputPreviewTask,
	type VodInputTimelineDocument,
} from "@bitovp/core/vod-input-timeline";
import type { WizardInputFile } from "../build-plan";
import type { ImageOutputLocation } from "./image-placement-dialog";

export type TimelinePreparation = { key: string; task: VodInputPreviewTask };

/** Changing source addressing, edits, or the output invalidates the editor receipt immediately. */
export function timelinePreparationKey(
	document: VodInputTimelineDocument,
	sources: WizardInputFile[],
	output: ImageOutputLocation,
	probeId?: string | null,
) {
	return JSON.stringify({
		document: normalizeVodInputTimelineDocument(document),
		probeId,
		sources: sources
			.filter((file) => file.purpose !== "FILTER_IMAGE")
			.map(({ key, kind, credentialId, bucket, path }) => ({
				key,
				kind,
				credentialId,
				bucket,
				path,
			})),
		output: {
			credentialId: output.credentialId,
			bucket: output.bucket,
			prefix: output.prefix,
		},
	});
}
