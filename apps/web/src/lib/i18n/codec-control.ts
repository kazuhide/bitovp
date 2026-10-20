import type { Translator } from "./context";
import type { MessageKey } from "./index";

const messages: Record<string, MessageKey> = {
	PLAN_CODEC_BITRATE_RANGE: "wizard.codecBitrateRange",
	PLAN_CODEC_GOP_RANGE: "wizard.codecGopRange",
	PLAN_CODEC_SAR_PAIR: "wizard.codecSarPair",
	PLAN_CODEC_ASPECT_CONFLICT: "wizard.codecAspectConflict",
	PLAN_CODEC_QP_RANGE: "wizard.codecQpRange",
	PLAN_CODEC_STRICT_CBR_MODE: "wizard.codecStrictCbrMode",
};

export function codecControlIssueMessage(
	code: string,
	t: Translator,
): string | undefined {
	const message = Object.hasOwn(messages, code) ? messages[code] : undefined;
	return message === undefined ? undefined : t(message);
}
