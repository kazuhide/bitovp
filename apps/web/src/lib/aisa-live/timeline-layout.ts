import type { AisaPlaybackMoment } from "./playback";

type Moment = AisaPlaybackMoment & { id: string };
export type TimelineMarker = {
	id: string;
	lane: number;
	startPercent: number;
	endPercent: number;
	anchorPercent: number;
	hitLeftPercent: number;
	hitWidthPercent: number;
};

/** A minimum 28.8px hit area at the timeline's 640px minimum width. */
const HIT_WIDTH = 4.5;

export function layoutMomentTracks(
	moments: readonly Moment[],
	duration: number,
) {
	const until: number[] = [];
	const percent = (time: number) =>
		Math.max(0, Math.min(100, (time / duration) * 100));
	const markers: TimelineMarker[] = [...moments]
		.sort(
			(a, b) => a.startInSeconds - b.startInSeconds || a.id.localeCompare(b.id),
		)
		.map((moment) => {
			const startPercent = percent(moment.startInSeconds);
			const endPercent = percent(moment.endInSeconds);
			const anchorPercent = percent(moment.anchorInSeconds);
			const hitLeftPercent = Math.max(
				0,
				Math.min(100 - HIT_WIDTH, anchorPercent - HIT_WIDTH / 2),
			);
			const beginning = Math.min(startPercent, hitLeftPercent);
			const ending = Math.max(endPercent, hitLeftPercent + HIT_WIDTH);
			let lane = until.findIndex((end) => end <= beginning);
			if (lane < 0) lane = until.length;
			until[lane] = ending;
			return {
				id: moment.id,
				lane,
				startPercent,
				endPercent,
				anchorPercent,
				hitLeftPercent,
				hitWidthPercent: HIT_WIDTH,
			};
		});
	return { moments: markers, lanes: until.length };
}

export function formatMomentTime(seconds: number) {
	if (!Number.isFinite(seconds)) return "—";
	const tenths = Math.round(Math.max(0, seconds) * 10);
	const whole = Math.floor(tenths / 10);
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor(whole / 60) % 60;
	const clock = hours
		? `${hours}:${String(minutes).padStart(2, "0")}`
		: String(minutes);
	return `${clock}:${String(whole % 60).padStart(2, "0")}.${tenths % 10}`;
}
