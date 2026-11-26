import type { ProcessRunner } from "./supervisor";

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
	tracks: { video: number; audio?: number },
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
			"packet=stream_index,flags:packet_side_data=side_data_type,skip_samples,discard_padding",
			"-of",
			"compact=p=0:nk=0",
			path,
		],
		{
			signal,
			onStdoutLine(line) {
				if (!line.trim()) return;
				const fields = /^stream_index=(\d+)\|flags=([A-Z_]+)(?:\||$)/.exec(
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
						: index === tracks.audio
							? "audio"
							: undefined;
				if (!track) return;
				const flags = fields[2] ?? "";
				if (flags.includes("C")) invalid = true;
				if (
					flags.includes("D") &&
					(track !== "audio" ||
						counts.audio !== 0 ||
						!/(?:^|\|)(?:[^|=]+:)?side_data_type=Skip Samples(?:\||$)/.test(
							line,
						) ||
						!/(?:^|\|)(?:[^|=]+:)?skip_samples=[1-9]\d*(?:\||$)/.test(line) ||
						!/(?:^|\|)(?:[^|=]+:)?discard_padding=0(?:\||$)/.test(line))
				) {
					unsupportedEdit = true;
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
