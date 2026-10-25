import type { PerTitleApiSettings } from "@bitovp/core";

export const PER_TITLE_STREAM_CHOICES = [
	"template",
	"template-resolution",
	"fixed-resolution",
	"fixed-range",
] as const;

export type PerTitleStreamChoice = (typeof PER_TITLE_STREAM_CHOICES)[number];
type StreamMode = PerTitleApiSettings["streams"][number]["mode"];
type StreamDimensions = { mode: StreamMode; height?: number; width?: number };

export function perTitleStreamMode(choice: PerTitleStreamChoice): StreamMode {
	if (choice === "fixed-resolution")
		return "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
	if (choice === "fixed-range")
		return "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
	return "PER_TITLE_TEMPLATE";
}

export function perTitleStreamChoice({
	mode,
	height,
	width,
}: StreamDimensions): PerTitleStreamChoice {
	if (mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION") return "fixed-resolution";
	if (mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")
		return "fixed-range";
	return height === undefined && width === undefined
		? "template"
		: "template-resolution";
}

export function perTitleStreamChoiceLabel(
	choice: PerTitleStreamChoice,
	locale: "en" | "ja",
) {
	const mode = perTitleStreamMode(choice);
	if (choice === "template")
		return `${mode} (${locale === "ja" ? "解像度なし" : "no resolution"})`;
	if (choice === "template-resolution")
		return `${mode} (${locale === "ja" ? "解像度指定" : "resolution specified"})`;
	return mode;
}

export function perTitleStreamLabel(
	stream: StreamDimensions,
	locale: "en" | "ja",
) {
	return perTitleStreamChoiceLabel(perTitleStreamChoice(stream), locale);
}
