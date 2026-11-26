import type { ProcessRunner } from "./supervisor";

type AudioTrack = {
	index: number;
	sampleRate?: string;
	timeBase?: string;
};

/** A whole priming packet can be included in the copy, unlike a partial edit. */
function isCompletePreroll(
	line: string,
	skip: string | undefined,
	audio: AudioTrack | undefined,
) {
	if (!skip || !audio?.sampleRate || !audio.timeBase) return false;
	const duration = /(?:^|\|)duration=([1-9]\d*)(?:\||$)/.exec(line)?.[1];
	const scale = /^([1-9]\d*)\/([1-9]\d*)$/.exec(audio.timeBase);
	if (
		!duration ||
		!scale?.[1] ||
		!scale[2] ||
		!/^[1-9]\d*$/.test(audio.sampleRate)
	)
		return false;
	return (
		BigInt(skip) * BigInt(scale[2]) ===
		BigInt(duration) * BigInt(scale[1]) * BigInt(audio.sampleRate)
	);
}

/**
 * Count packets after demux and reject timeline edits the live muxers cannot
 * express. FFmpeg streamcopy can carry a discard-marked picture across the
 * boundary while dropping the discard flag. The first AAC priming packet
 * is codec preroll and remains part of the source copy.
 */
export async function inspectSinglePassPackets(
	runner: Pick<ProcessRunner, "run">,
	ffprobe: string,
	path: string,
	tracks: { video: number; audio?: AudioTrack },
	signal: AbortSignal,
): Promise<{ video: number; audio: number } | { error: string }> {
	const counts = { video: 0, audio: 0 };
	let invalid = false;
	let unsupportedEdit = false;
	const result = await runner.run(
		ffprobe,
		[
			"-v",
			"error",
			"-show_packets",
			"-show_entries",
			"packet=stream_index,duration,flags:packet_side_data=side_data_type,skip_samples,discard_padding",
			"-of",
			"compact=p=0:nk=0",
			path,
		],
		{
			signal,
			onStdoutLine(line) {
				if (!line.trim()) return;
				const fields =
					/^stream_index=(\d+)\|(?:duration=[^|]+\|)?flags=([A-Z_]+)(?:\||$)/.exec(
						line,
					);
				if (!fields) {
					invalid = true;
					return;
				}
				const index = Number(fields[1]);
				const track =
					index === tracks.video
						? "video"
						: index === tracks.audio?.index
							? "audio"
							: undefined;
				if (!track) return;
				const flags = fields[2] ?? "";
				if (flags.includes("C")) invalid = true;
				const sampleEdit =
					/(?:^|\|)(?:[^|=]+:)?side_data_type=Skip Samples(?:\||$)/.test(line);
				const discard = flags.includes("D");
				if (discard || sampleEdit) {
					const skipped = /(?:^|\|)(?:[^|=]+:)?skip_samples=(\d+)(?:\||$)/.exec(
						line,
					)?.[1];
					const padding =
						/(?:^|\|)(?:[^|=]+:)?discard_padding=(\d+)(?:\||$)/.exec(line)?.[1];
					const unedited = !discard && skipped === "0" && padding === "0";
					const priming =
						discard &&
						sampleEdit &&
						track === "audio" &&
						counts.audio === 0 &&
						padding === "0" &&
						isCompletePreroll(line, skipped, tracks.audio);
					if (!unedited && !priming) unsupportedEdit = true;
				}
				counts[track] += 1;
			},
		},
	);
	if (result.code !== 0 || result.stderr.trim()) {
		const detail = result.stderr.trim().split("\n").at(-1) || "no output";
		return { error: `ffprobe failed to count source packets: ${detail}` };
	}
	if (unsupportedEdit)
		return {
			error:
				"single-pass playback cannot preserve this source's edit list in the live muxer",
		};
	if (
		invalid ||
		counts.video === 0 ||
		(tracks.audio !== undefined && counts.audio === 0)
	)
		return {
			error:
				"single-pass playback requires a complete packet count for each selected stream",
		};
	return counts;
}
