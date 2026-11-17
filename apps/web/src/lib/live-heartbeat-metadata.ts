/**
 * Initial-connection metadata is descriptive, not a health measurement.
 * Share this boundary between public projections and operator raw views:
 * unknown provider strings must not become browser-visible credentials.
 */
export function heartbeatAspectRatio(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// Positive integer ratio, at most 21 characters; no expressions, labels,
	// whitespace or undefined (0:0) ratios. Compare the entire match because
	// JavaScript's $ anchor also accepts a position before a final newline.
	return /^[1-9]\d{0,9}:[1-9]\d{0,9}$/.exec(value)?.[0] === value
		? value
		: undefined;
}

export function heartbeatAudioChannels(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

// Standard labels only; custom channel names and unknown labels stay withheld.
// https://ffmpeg.org/ffmpeg-utils.html#Channel-Layout
const AUDIO_CHANNEL_FORMATS = new Set([
	"mono",
	"stereo",
	"2.1",
	"3.0",
	"3.0(back)",
	"4.0",
	"quad",
	"quad(side)",
	"3.1",
	"5.0",
	"5.0(side)",
	"4.1",
	"5.1",
	"5.1(side)",
	"6.0",
	"6.0(front)",
	"3.1.2",
	"hexagonal",
	"6.1",
	"6.1(front)",
	"7.0",
	"7.0(front)",
	"7.1",
	"7.1(wide)",
	"7.1(wide-side)",
	"5.1.2",
	"octagonal",
	"cube",
	"5.1.4",
	"7.1.2",
	"7.1.4",
	"7.2.3",
	"9.1.4",
	"9.1.6",
	"hexadecagonal",
	"binaural",
	"downmix",
	"22.2",
]);

export function heartbeatAudioChannelFormat(
	value: unknown,
): string | undefined {
	return typeof value === "string" && AUDIO_CHANNEL_FORMATS.has(value)
		? value
		: undefined;
}
