import { expect, it } from "vitest";
import { codecControlIssueMessage } from "./codec-control";
import { messagesFor, translate } from "./index";

it.each([
	"en",
	"ja",
] as const)("translates every codec constraint in %s", (locale) => {
	const t = (key: Parameters<typeof translate>[1]) =>
		translate(messagesFor(locale), key);
	for (const code of [
		"PLAN_CODEC_BITRATE_RANGE",
		"PLAN_CODEC_GOP_RANGE",
		"PLAN_CODEC_SAR_PAIR",
		"PLAN_CODEC_ASPECT_CONFLICT",
		"PLAN_CODEC_QP_RANGE",
		"PLAN_CODEC_STRICT_CBR_MODE",
		"PLAN_AV1_MAX_LEVEL_DISABLED",
		"PLAN_AV1_DETAIL_PRESERVATION_VERSION",
		"PLAN_AV1_DETAIL_PRESERVATION_VERSION_UNRESOLVED",
	]) {
		const value = codecControlIssueMessage(code, t);
		expect(value).toBeTruthy();
		if (locale === "ja") expect(value).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
	}
	expect(codecControlIssueMessage("UNKNOWN", t)).toBeUndefined();
	expect(codecControlIssueMessage("constructor", t)).toBeUndefined();
});
