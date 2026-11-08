import { subjectBox2dSchema } from "../content-library/analysis";
import {
	type FramingGeometry,
	subjectCenterFromPercent,
	suggestFixedCrop,
} from "./framing";
import type { NormalizedCropRect } from "./schema";

export type ShotCropCandidate = {
	id: string;
	kind: "AISA" | "POSITION";
	rect: NormalizedCropRect;
	subjectIndex?: number;
	coverage: "FULL" | "PARTIAL" | "UNKNOWN";
};
export type ShotCropCandidatesInput = FramingGeometry & {
	/** Existing normalized AISA document values: centres in percent, box axes 0..1000. */
	mainSubjects?: readonly {
		classification?: unknown;
		centerX?: unknown;
		centerY?: unknown;
		box2d?: unknown;
	}[];
};
const humanClassifications = new Set([
	"person",
	"people",
	"human",
	"man",
	"woman",
	"boy",
	"girl",
	"child",
	"baby",
	"人物",
	"人",
	"男性",
	"女性",
	"少年",
	"少女",
	"子供",
	"子ども",
]);

/** Fixed editorial proposals from one AISA appearance; never a track or speaker claim. */
export function shotCropCandidates(
	input: ShotCropCandidatesInput,
): ShotCropCandidate[] {
	const { sourceWidth, sourceHeight, targetWidth, targetHeight } = input;
	const geometry = { sourceWidth, sourceHeight, targetWidth, targetHeight };
	const center = suggestFixedCrop({ ...geometry, centerX: 0.5, centerY: 0.5 });
	const near = (a: NormalizedCropRect, b: NormalizedCropRect) =>
		Math.abs(a.x - b.x) * sourceWidth <= 2 &&
		Math.abs(a.y - b.y) * sourceHeight <= 2 &&
		Math.abs(a.w - b.w) * sourceWidth <= 2 &&
		Math.abs(a.h - b.h) * sourceHeight <= 2;
	const ranked = (input.mainSubjects ?? [])
		.flatMap((subject, index) => {
			const parsed = subjectBox2dSchema.safeParse(subject.box2d);
			const box = parsed.success
				? {
						x: parsed.data[1] / 1000,
						y: parsed.data[0] / 1000,
						w: (parsed.data[3] - parsed.data[1]) / 1000,
						h: (parsed.data[2] - parsed.data[0]) / 1000,
					}
				: undefined;
			const point = box
				? { x: box.x + box.w / 2, y: box.y + box.h / 2 }
				: subjectCenterFromPercent(subject.centerX, subject.centerY);
			if (!point) return [];
			const maximum = suggestFixedCrop({
				...geometry,
				centerX: point.x,
				centerY: point.y,
			});
			const zoom = box
				? Math.max(
						1,
						Math.min(3, (maximum.w * 0.8) / box.w, (maximum.h * 0.8) / box.h),
					)
				: 1;
			const rect = suggestFixedCrop({
				...geometry,
				centerX: point.x,
				centerY: point.y,
				zoom,
			});
			const full =
				box &&
				rect.x <= box.x + 1e-9 &&
				rect.y <= box.y + 1e-9 &&
				rect.x + rect.w >= box.x + box.w - 1e-9 &&
				rect.y + rect.h >= box.y + box.h - 1e-9;
			const area = box ? box.w * box.h : 0;
			const candidate: ShotCropCandidate = {
				id: `aisa-${index}`,
				kind: "AISA",
				rect,
				subjectIndex: index,
				coverage: box ? (full ? "FULL" : "PARTIAL") : "UNKNOWN",
			};
			return [
				{
					candidate,
					index,
					human:
						typeof subject.classification === "string" &&
						humanClassifications.has(
							subject.classification.trim().toLowerCase(),
						),
					full: Boolean(full),
					reasonable: area >= 0.01 && area <= 0.6,
				},
			];
		})
		.sort(
			(a, b) =>
				Number(b.human) - Number(a.human) ||
				Number(b.full) - Number(a.full) ||
				Number(b.reasonable) - Number(a.reasonable) ||
				a.index - b.index,
		);
	const candidates: ShotCropCandidate[] = [];
	for (const item of ranked) {
		if (candidates.some((value) => near(value.rect, item.candidate.rect)))
			continue;
		candidates.push(item.candidate);
		if (candidates.length === 2) break;
	}
	// Reserve centre before deduplication, so a source already as narrow as the
	// target retains a central choice instead of a misleading left/right label.
	const positions: ShotCropCandidate[] = [];
	for (const [id, x] of [
		["center", 0.5],
		["left", 0],
		["right", 1],
	] as const) {
		const rect =
			id === "center"
				? center
				: suggestFixedCrop({ ...geometry, centerX: x, centerY: 0.5 });
		if ([...candidates, ...positions].some((value) => near(value.rect, rect)))
			continue;
		positions.push({ id, kind: "POSITION", rect, coverage: "UNKNOWN" });
	}
	const order = { left: 0, center: 1, right: 2 };
	positions.sort(
		(a, b) =>
			order[a.id as keyof typeof order] - order[b.id as keyof typeof order],
	);
	return [...candidates, ...positions];
}
