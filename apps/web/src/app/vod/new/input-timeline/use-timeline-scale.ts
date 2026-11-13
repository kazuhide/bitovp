"use client";

import { type RefObject, useEffect, useState } from "react";

const DEFAULT_PIXELS_PER_MS = 0.04;
const TAIL_MS = 3000;
const TICK_STEPS_MS = [
	100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000,
	300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000,
	43_200_000, 86_400_000,
];

export function useTimelineScale(viewport: RefObject<HTMLDivElement | null>) {
	const [viewportWidth, setViewportWidth] = useState(0);
	const [scrollLeft, setScrollLeft] = useState(0);
	const [scale, setScale] = useState({
		zoom: "1",
		pixelsPerMs: DEFAULT_PIXELS_PER_MS,
	});
	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const measure = () => setViewportWidth(element.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [viewport]);
	return {
		...scale,
		viewportWidth,
		scrollLeft,
		factor: scale.pixelsPerMs / DEFAULT_PIXELS_PER_MS,
		onScroll: () => setScrollLeft(viewport.current?.scrollLeft ?? 0),
		setZoom(value: string) {
			setScale({
				zoom: value,
				pixelsPerMs: DEFAULT_PIXELS_PER_MS * Number(value),
			});
		},
		fit(durationMs: number) {
			const element = viewport.current;
			const width = element?.clientWidth;
			if (!element || !width || !durationMs) return;
			setScale({
				zoom: "custom",
				pixelsPerMs: width / (durationMs + Math.max(TAIL_MS, durationMs * 0.2)),
			});
			element.scrollLeft = 0;
			setScrollLeft(0);
		},
		canvas(durationMs: number) {
			const widthPx = Math.max(
				viewportWidth,
				(durationMs + TAIL_MS) * scale.pixelsPerMs,
			);
			// Only the visible ruler needs labels, even for a 24-hour sequence at 8×.
			const spacing = Math.max(96, viewportWidth / 60);
			const step =
				TICK_STEPS_MS.find((value) => value * scale.pixelsPerMs >= spacing) ??
				86_400_000;
			const left = Math.min(scrollLeft, Math.max(0, widthPx - viewportWidth));
			const first = Math.max(
				0,
				Math.floor(left / scale.pixelsPerMs / step) - 1,
			);
			const last = Math.ceil((left + viewportWidth) / scale.pixelsPerMs / step);
			const ticks = Array.from(
				{ length: last - first + 2 },
				(_, index) => (first + index) * step,
			).filter((value) => value * scale.pixelsPerMs <= widthPx);
			return { widthPx, ticks };
		},
	};
}
