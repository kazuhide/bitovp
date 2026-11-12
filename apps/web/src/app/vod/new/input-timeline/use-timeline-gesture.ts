"use client";
import type {
	VodInputTimelineSourceFacts,
	VodInputTimelineTrack,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	changeRange,
	moveClip,
	timelineDuration,
	timelineItems,
} from "./timeline-state";

type Mode = "in" | "out" | "move";
type Target = HTMLButtonElement | HTMLDivElement;
type Gesture = {
	id: string;
	track: VodInputTimelineTrack;
	mode: Mode;
	linked: boolean;
	pointer: number;
	x: number;
	pixelsPerMs: number;
	extentMs: number;
	target: Target;
	base: VodInputTimelineV2Document;
	next: VodInputTimelineV2Document;
};
export function useTimelineGesture({
	document,
	facts,
	disabled,
	track,
	pixelsPerMs,
	linked = true,
	onChange,
	onSelect,
	onError,
}: {
	document: VodInputTimelineV2Document;
	facts: VodInputTimelineSourceFacts[];
	disabled: boolean;
	track: RefObject<HTMLDivElement | null>;
	pixelsPerMs: number;
	linked?: boolean;
	onChange: (next: VodInputTimelineV2Document) => void;
	onSelect: (id: string, track: VodInputTimelineTrack) => void;
	onError: () => void;
}) {
	const gesture = useRef<Gesture | null>(null);
	const suppressClick = useRef<string | null>(null);
	const latest = useRef({ document, disabled, onChange });
	latest.current = { document, disabled, onChange };
	const [shown, setShown] = useState<Pick<Gesture, "next" | "extentMs"> | null>(
		null,
	);
	const finish = useCallback((commit: boolean) => {
		const active = gesture.current;
		if (!active) return;
		gesture.current = null;
		setShown(null);
		if (active.mode === "move" && active.next !== active.base)
			suppressClick.current = `${active.track}:${active.id}`;
		if (active.target.hasPointerCapture?.(active.pointer))
			active.target.releasePointerCapture(active.pointer);
		if (
			commit &&
			!latest.current.disabled &&
			latest.current.document === active.base &&
			active.next !== active.base
		)
			latest.current.onChange(active.next);
	}, []);
	useEffect(() => {
		if (disabled || (gesture.current && document !== gesture.current.base))
			finish(false);
	}, [document, disabled, finish]);
	useEffect(() => {
		function handleEscape(event: KeyboardEvent) {
			if (event.key === "Escape" && gesture.current) {
				event.preventDefault();
				finish(false);
			}
		}
		window.addEventListener("keydown", handleEscape);
		return () => {
			window.removeEventListener("keydown", handleEscape);
			const active = gesture.current;
			if (active?.target.hasPointerCapture?.(active.pointer))
				active.target.releasePointerCapture(active.pointer);
			gesture.current = null;
		};
	}, [finish]);
	function trim(
		base: VodInputTimelineV2Document,
		id: string,
		medium: VodInputTimelineTrack,
		pair: boolean,
		mode: "in" | "out",
		delta: number,
	) {
		const clip = timelineItems(base, medium).find(
			(item) => item.clip.id === id,
		)?.clip;
		const source = facts.find((item) => item.key === clip?.sourceKey);
		if (!clip || !source) return base;
		const rate = medium === "video" ? source.video?.frameRate : null;
		const tick = rate ? (1000 * rate.den) / rate.num : 1;
		const amount = Math.round(Math.round(delta / tick) * tick);
		const inMs =
			mode === "in"
				? Math.max(0, Math.min(clip.outMs - 1, clip.inMs + amount))
				: clip.inMs;
		const sourceDuration = source[medium]?.durationMs ?? source.durationMs;
		const outMs =
			mode === "out"
				? Math.min(sourceDuration, Math.max(clip.inMs + 1, clip.outMs + amount))
				: clip.outMs;
		try {
			return changeRange(base, id, inMs, outMs, facts, {
				track: medium,
				linked: pair,
			});
		} catch {
			onError();
			return base;
		}
	}
	function move(pointer: number, clientX: number) {
		const active = gesture.current;
		if (!active || pointer !== active.pointer) return;
		if (disabled || document !== active.base) return finish(false);
		const left = track.current?.getBoundingClientRect().left;
		if (left === undefined) return;
		const delta = Math.round((clientX - left - active.x) / active.pixelsPerMs);
		if (active.mode === "move") {
			const items = timelineItems(active.base, active.track);
			const item = items.find((entry) => entry.clip.id === active.id);
			if (!item) return;
			const center = item.startMs + item.durationMs / 2 + delta;
			const others = items.filter((entry) => entry.clip.id !== active.id);
			const index = others.findIndex(
				(entry) => center < entry.startMs + entry.durationMs / 2,
			);
			try {
				active.next = moveClip(
					active.base,
					active.id,
					index < 0 ? others.length : index,
					{ track: active.track, linked: active.linked },
				);
			} catch {
				onError();
				active.next = active.base;
			}
		} else
			active.next = trim(
				active.base,
				active.id,
				active.track,
				active.linked,
				active.mode,
				delta,
			);
		active.extentMs = Math.max(active.extentMs, timelineDuration(active.next));
		setShown({ next: active.next, extentMs: active.extentMs });
	}
	function handlers(
		id: string,
		mode: Mode,
		medium: VodInputTimelineTrack = "video",
	) {
		return {
			onPointerDown(event: React.PointerEvent<Target>) {
				if (disabled || gesture.current || event.button !== 0) return;
				const clip = timelineItems(document, medium).find(
					(item) => item.clip.id === id,
				)?.clip;
				if (
					mode !== "move" &&
					!facts.some((item) => item.key === clip?.sourceKey && item[medium])
				)
					return;
				const bounds = track.current?.getBoundingClientRect(),
					total = timelineDuration(document);
				if (!bounds || !pixelsPerMs || !total) return;
				event.preventDefault();
				event.currentTarget.focus();
				onSelect(id, medium);
				event.currentTarget.setPointerCapture(event.pointerId);
				gesture.current = {
					id,
					track: medium,
					mode,
					linked,
					pointer: event.pointerId,
					x: event.clientX - bounds.left,
					pixelsPerMs,
					extentMs: total,
					target: event.currentTarget,
					base: document,
					next: document,
				};
				suppressClick.current = null;
				setShown({ next: document, extentMs: total });
			},
			onPointerMove(event: React.PointerEvent<Target>) {
				move(event.pointerId, event.clientX);
			},
			onPointerUp(event: React.PointerEvent<Target>) {
				if (gesture.current?.pointer === event.pointerId) {
					move(event.pointerId, event.clientX);
					finish(true);
				}
			},
			onPointerCancel(event: React.PointerEvent<Target>) {
				if (gesture.current?.pointer === event.pointerId) finish(false);
			},
			onLostPointerCapture(event: React.PointerEvent<Target>) {
				if (gesture.current?.pointer === event.pointerId) finish(false);
			},
			onKeyDown(event: React.KeyboardEvent<Target>) {
				if (
					disabled ||
					gesture.current ||
					!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
				)
					return;
				const items = timelineItems(document, medium),
					index = items.findIndex((item) => item.clip.id === id),
					clip = items[index]?.clip;
				if (mode === "move" && !event.altKey) return;
				event.preventDefault();
				onSelect(id, medium);
				if (mode === "move") {
					try {
						onChange(
							moveClip(
								document,
								id,
								event.key === "Home"
									? 0
									: event.key === "End"
										? items.length - 1
										: index + (event.key === "ArrowLeft" ? -1 : 1),
								{ track: medium, linked },
							),
						);
					} catch {
						onError();
					}
					return;
				}
				const fact = facts.find((item) => item.key === clip?.sourceKey);
				if (!fact) return;
				const rate = medium === "video" ? fact.video?.frameRate : null;
				const tick = rate ? (1000 * rate.den) / rate.num : 1;
				const delta =
					event.key === "Home"
						? -fact.durationMs
						: event.key === "End"
							? fact.durationMs
							: (event.key === "ArrowLeft" ? -1 : 1) *
								tick *
								(event.shiftKey ? 10 : 1);
				onChange(trim(document, id, medium, linked, mode, delta));
			},
		};
	}
	return {
		shown: shown?.next ?? document,
		extentMs: shown?.extentMs ?? timelineDuration(document),
		dragging: shown !== null,
		handlers,
		consumeClick(id: string, medium: VodInputTimelineTrack = "video") {
			const suppressed = suppressClick.current === `${medium}:${id}`;
			suppressClick.current = null;
			return suppressed;
		},
	};
}
