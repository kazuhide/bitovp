import { AUDIO_CODECS } from "./schema";
import {
	allowedStreamOperators,
	availableStreamAttributes,
	type StreamCondition,
	streamAttributes,
	validStreamValue,
} from "./stream-conditions";
import type { PlanIssue } from "./validate";

export function checkStreamConditions(
	renditions: readonly { codec: string; conditions?: StreamCondition }[],
	live: boolean,
): PlanIssue[] {
	const issues: PlanIssue[] = [];
	for (const [index, r] of renditions.entries()) {
		if (!r.conditions) continue;
		const media = AUDIO_CODECS.has(r.codec)
			? "audio"
			: r.codec === "IMSC" || r.codec === "WEBVTT"
				? "subtitle"
				: "video";
		const available = availableStreamAttributes(media, live);
		const visit = (c: StreamCondition, path: string) => {
			if ("conditions" in c) {
				for (const [n, item] of c.conditions.entries()) {
					visit(item, `${path}.conditions[${n}]`);
				}
				return;
			}
			const attr = streamAttributes.find((a) => a.key === c.attribute);
			// Preserve custom attributes from older expert plans. The form offers
			// the provider's documented attributes for this stream.
			if (!attr) {
				issues.push({
					code: "PLAN_STREAM_CONDITION_CUSTOM",
					level: "warning",
					path,
					message: `Unlisted stream condition attribute "${c.attribute}"`,
				});
				return;
			}
			const fail = (reason: string) =>
				issues.push({
					code: "PLAN_STREAM_CONDITION_INVALID",
					level: "error",
					path,
					message: `${c.attribute}: ${reason}`,
				});
			if (!available.includes(attr))
				fail(`unavailable for this ${live ? "Live" : "VOD"} ${media} stream`);
			else if (!allowedStreamOperators(attr.format).includes(c.operator))
				fail("unsupported comparison");
			else if (!validStreamValue(c.value, attr.format))
				fail("invalid comparison value");
		};
		visit(r.conditions, `renditions[${index}].conditions`);
	}
	return issues;
}
