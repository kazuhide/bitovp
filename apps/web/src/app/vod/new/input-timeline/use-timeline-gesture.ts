"use client";

import type {
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
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
	mode: Mode;
	pointer: number;
	x: number;
	pixelsPerMs: number;
	target: Target;
	base: VodInputTimelineDocument;
	next: VodInputTimelineDocument;
};
export function useTimelineGesture({
	document,
	facts,
	disabled,
	track,
	pixelsPerMs,
	onChange,
	onSelect,
	onError,
}: {
	document: VodInputTimelineDocument;
	facts: VodInputTimelineSourceFacts[];
	disabled: boolean;
	track: RefObject<HTMLDivElement | null>;
	pixelsPerMs: number;
	onChange: (next: VodInputTimelineDocument) => void;
	onSelect: (id: string) => void;
	onError: () => void;
}) {
	const gesture = useRef<Gesture | null>(null);
	const suppressClick = useRef<string | null>(null);
	const latest = useRef({ document, disabled, onChange });
	latest.current = { document, disabled, onChange };
	const [shown, setShown] = useState<VodInputTimelineDocument | null>(null);
	const finish = useCallback((commit: boolean) => {
		const active = gesture.current;
		if (!active) return;
		gesture.current = null;
		setShown(null);
		if (active.mode === "move" && active.next !== active.base)
			suppressClick.current = active.id;
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
		base: VodInputTimelineDocument,
		id: string,
		mode: "in" | "out",
		delta: number,
	) {
		const clip = base.clips.find((item) => item.id === id);
		const source = facts.find((item) => item.key === clip?.sourceKey);
		if (!clip || !source) return base;
		const rate = source.video.frameRate;
		const tick = rate ? (1000 * rate.den) / rate.num : 1;
		const amount = Math.round(Math.round(delta / tick) * tick);
		const inMs =
			mode === "in"
				? Math.max(0, Math.min(clip.outMs - 1, clip.inMs + amount))
				: clip.inMs;
		const outMs =
			mode === "out"
				? Math.min(
						source.durationMs,
						Math.max(clip.inMs + 1, clip.outMs + amount),
					)
				: clip.outMs;
		try {
			return changeRange(base, id, inMs, outMs, facts);
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
			const items = timelineItems(active.base);
			const item = items.find((entry) => entry.clip.id === active.id);
			if (!item) return;
			const center = item.startMs + item.durationMs / 2 + delta;
			const others = items.filter((entry) => entry.clip.id !== active.id);
			const index = others.findIndex(
				(entry) => center < entry.startMs + entry.durationMs / 2,
			);
			active.next = moveClip(
				active.base,
				active.id,
				index < 0 ? others.length : index,
			);
		} else active.next = trim(active.base, active.id, active.mode, delta);
		setShown(active.next);
	}
	function handlers(id: string, mode: Mode) {
		return {
			onPointerDown(event: React.PointerEvent<Target>) {
				if (disabled || gesture.current || event.button !== 0) return;
				const clip = document.clips.find((item) => item.id === id);
				if (
					mode !== "move" &&
					!facts.some((item) => item.key === clip?.sourceKey)
				)
					return;
				const bounds = track.current?.getBoundingClientRect();
				const total = timelineDuration(document);
				if (!bounds || !pixelsPerMs || !total) return;
				event.preventDefault();
				event.currentTarget.focus();
				onSelect(id);
				event.currentTarget.setPointerCapture(event.pointerId);
				gesture.current = {
					id,
					mode,
					pointer: event.pointerId,
					x: event.clientX - bounds.left,
					pixelsPerMs,
					target: event.currentTarget,
					base: document,
					next: document,
				};
				suppressClick.current = null;
				setShown(document);
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
				const index = document.clips.findIndex((item) => item.id === id);
				const clip = document.clips[index];
				const fact = facts.find((item) => item.key === clip?.sourceKey);
				if (mode === "move" && !event.altKey) return;
				event.preventDefault();
				onSelect(id);
				if (mode === "move")
					return onChange(
						moveClip(
							document,
							id,
							index + (event.key === "ArrowLeft" ? -1 : 1),
						),
					);
				if (!fact) return;
				const rate = fact.video.frameRate;
				const tick = rate ? (1000 * rate.den) / rate.num : 1;
				const delta =
					event.key === "Home"
						? -fact.durationMs
						: event.key === "End"
							? fact.durationMs
							: (event.key === "ArrowLeft" ? -1 : 1) *
								tick *
								(event.shiftKey ? 10 : 1);
				onChange(trim(document, id, mode, delta));
			},
		};
	}
	return {
		shown: shown ?? document,
		dragging: shown !== null,
		handlers,
		consumeClick(id: string) {
			const suppressed = suppressClick.current === id;
			suppressClick.current = null;
			return suppressed;
		},
	};
}
