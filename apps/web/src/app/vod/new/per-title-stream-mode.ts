import type { PerTitleApiSettings } from "@bitovp/core";

export const PER_TITLE_STREAM_CHOICES = [
	"template",
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
}: StreamDimensions): PerTitleStreamChoice {
	if (mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION") return "fixed-resolution";
	if (mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")
		return "fixed-range";
	return "template";
}

export function perTitleStreamChoiceLabel(choice: PerTitleStreamChoice) {
	return perTitleStreamMode(choice);
}

export function perTitleStreamLabel(stream: StreamDimensions) {
	return stream.mode;
}
