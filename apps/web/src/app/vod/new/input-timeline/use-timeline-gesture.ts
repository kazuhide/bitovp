"use client";
import {
	VodInputTimelineEditError,
	type VodInputTimelineSourceFacts,
	type VodInputTimelineTrack,
	type VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { availableSourceDuration } from "./source-availability";
import {
	snapTimelineBody,
	snapTimelineTime,
	timelineSnapCandidates,
} from "./timeline-snapping";
import {
	changeRange,
	linkedPartner,
	moveClip,
	placeClip,
	timelineDuration,
	timelineItems,
} from "./timeline-state";

type Mode = "in" | "out" | "move";
type Target = HTMLButtonElement | HTMLDivElement;
export type TimelineGestureError = "invalidRange" | "gapTooLong" | "trackFull";
function errorLabel(error: unknown): TimelineGestureError {
	if (error instanceof VodInputTimelineEditError) {
		if (error.code === "TIMELINE_GAP_TOO_LONG") return "gapTooLong";
		if (error.code === "TIMELINE_LIMIT_EXCEEDED") return "trackFull";
	}
	return "invalidRange";
}
type Gesture = {
	id: string;
	track: VodInputTimelineTrack;
	mode: Mode;
	linked: boolean;
	pointer: number;
	x: number;
	clientX: number;
	pixelsPerMs: number;
	extentMs: number;
	snapMs: number | null;
	snapEdge: "in" | "out" | null;
	dragged: boolean;
	candidates: number[];
	target: HTMLDivElement;
	focusTarget: Target;
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
	snapping = true,
	positionMs = 0,
	onChange,
	onSelect,
	onSeek,
	onError,
}: {
	document: VodInputTimelineV2Document;
	facts: VodInputTimelineSourceFacts[];
	disabled: boolean;
	track: RefObject<HTMLDivElement | null>;
	pixelsPerMs: number;
	linked?: boolean;
	snapping?: boolean;
	positionMs?: number;
	onChange: (next: VodInputTimelineV2Document) => void;
	onSelect: (id: string, track: VodInputTimelineTrack) => void;
	onSeek: (positionMs: number) => void;
	onError: (reason?: TimelineGestureError) => void;
}) {
	const gesture = useRef<Gesture | null>(null);
	const focusAfter = useRef<{
		target: Target;
		base: VodInputTimelineV2Document;
		next: VodInputTimelineV2Document;
	} | null>(null);
	const latest = useRef({ document, disabled, onChange });
	latest.current = { document, disabled, onChange };
	const [shown, setShown] = useState<Pick<
		Gesture,
		"next" | "extentMs" | "snapMs"
	> | null>(null);
	const modifierChanged = useRef<(altKey: boolean) => void>(() => {});
	modifierChanged.current = (altKey) => {
		const active = gesture.current;
		if (active && (active.mode !== "move" || !active.linked))
			move(active.pointer, active.clientX, altKey);
	};
	const finish = useCallback((commit: boolean) => {
		const active = gesture.current;
		if (!active) return;
		const focus = active.focusTarget;
		focusAfter.current =
			!latest.current.disabled &&
			latest.current.document === active.base &&
			focus.isConnected
				? { target: focus, base: active.base, next: active.next }
				: null;
		gesture.current = null;
		setShown(null);
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
	useLayoutEffect(() => {
		if (shown !== null) return;
		const request = focusAfter.current;
		focusAfter.current = null;
		if (
			!request ||
			disabled ||
			!request.target.isConnected ||
			(document !== request.base && document !== request.next)
		)
			return;
		if (
			request.target.ownerDocument.activeElement ===
			request.target.ownerDocument.body
		)
			request.target.focus({ preventScroll: true });
	}, [shown, document, disabled]);
	useEffect(() => {
		function handleEscape(event: KeyboardEvent) {
			if (
				event.key === "Escape" &&
				event.type === "keydown" &&
				gesture.current
			) {
				event.preventDefault();
				finish(false);
			} else if (
				event.key === "Alt" &&
				gesture.current &&
				(gesture.current.mode !== "move" || !gesture.current.linked)
			) {
				event.preventDefault();
				modifierChanged.current(event.type === "keydown");
			}
		}
		window.addEventListener("keydown", handleEscape);
		window.addEventListener("keyup", handleEscape);
		return () => {
			window.removeEventListener("keydown", handleEscape);
			window.removeEventListener("keyup", handleEscape);
			const active = gesture.current;
			gesture.current = null;
			focusAfter.current = null;
			if (active?.target.hasPointerCapture?.(active.pointer))
				active.target.releasePointerCapture(active.pointer);
		};
	}, [finish]);
	function trim(
		base: VodInputTimelineV2Document,
		id: string,
		medium: VodInputTimelineTrack,
		pair: boolean,
		mode: "in" | "out",
		delta: number,
		exact = false,
	) {
		const clip = timelineItems(base, medium).find(
			(item) => item.clip.id === id,
		)?.clip;
		const source = facts.find((item) => item.key === clip?.sourceKey);
		if (!clip || !source) return base;
		const rate = medium === "video" ? source.video?.frameRate : null;
		const tick = rate ? (1000 * rate.den) / rate.num : 1;
		const amount = exact
			? Math.round(delta)
			: Math.round(Math.round(delta / tick) * tick);
		const sourceDuration = availableSourceDuration(
			source,
			pair ? "both" : medium,
			base.audioEnabled,
		);
		const inMs =
			mode === "in"
				? Math.max(
						pair ? 0 : Math.max(0, clip.inMs - clip.startMs),
						Math.min(clip.outMs - 1, clip.inMs + amount),
					)
				: clip.inMs;
		const outMs =
			mode === "out"
				? Math.min(
						pair
							? sourceDuration
							: Math.min(
									sourceDuration,
									clip.inMs + base.durationMs - clip.startMs,
								),
						Math.max(clip.inMs + 1, clip.outMs + amount),
					)
				: clip.outMs;
		try {
			return changeRange(base, id, inMs, outMs, facts, {
				track: medium,
				linked: pair,
			});
		} catch (error) {
			onError(errorLabel(error));
			return base;
		}
	}
	function move(pointer: number, clientX: number, altKey = false) {
		const active = gesture.current;
		if (!active || pointer !== active.pointer) return;
		if (disabled || document !== active.base) return finish(false);
		const left = track.current?.getBoundingClientRect().left;
		if (left === undefined) return;
		const delta = Math.round((clientX - left - active.x) / active.pixelsPerMs);
		active.clientX = clientX;
		const previousSnap = active.snapMs;
		const previousEdge = active.snapEdge;
		active.snapMs = null;
		active.snapEdge = null;
		if (active.mode === "move") {
			const items = timelineItems(active.base, active.track);
			const item = items.find((entry) => entry.clip.id === active.id);
			if (!item) return;
			if (!active.dragged && Math.abs(delta * active.pixelsPerMs) >= 4)
				active.dragged = true;
			try {
				if (!active.dragged) {
					active.next = active.base;
				} else if (active.linked) {
					const center = item.startMs + item.durationMs / 2 + delta;
					const others = items.filter((entry) => entry.clip.id !== active.id);
					const index = others.findIndex(
						(entry) => center < entry.startMs + entry.durationMs / 2,
					);
					active.next = moveClip(
						active.base,
						active.id,
						index < 0 ? others.length : index,
						{ track: active.track, linked: true },
					);
				} else {
					const rawStart = item.startMs + delta;
					const snap =
						snapping && !altKey
							? snapTimelineBody(
									rawStart,
									item.durationMs,
									active.base.durationMs,
									active.candidates,
									active.pixelsPerMs,
									previousSnap !== null && previousEdge
										? { timeMs: previousSnap, edge: previousEdge }
										: null,
								)
							: null;
					active.snapMs = snap?.timeMs ?? null;
					active.snapEdge = snap?.edge ?? null;
					const startMs = Math.max(
						0,
						Math.min(
							active.base.durationMs - item.durationMs,
							snap
								? snap.timeMs - (snap.edge === "out" ? item.durationMs : 0)
								: rawStart,
						),
					);
					active.next =
						startMs === item.startMs
							? active.base
							: placeClip(
									active.base,
									{ id: active.id, track: active.track },
									startMs,
								);
				}
			} catch (error) {
				onError(errorLabel(error));
				active.next = active.base;
				active.snapMs = null;
				active.snapEdge = null;
			}
		} else {
			const clip = timelineItems(active.base, active.track).find(
				(item) => item.clip.id === active.id,
			)?.clip;
			const source = facts.find((item) => item.key === clip?.sourceKey);
			let snappedDelta = delta;
			if (!active.linked && snapping && !altKey && clip && source) {
				const end = clip.startMs + clip.outMs - clip.inMs;
				const edge = active.mode === "in" ? clip.startMs : end;
				const min =
					active.mode === "in"
						? Math.max(0, clip.startMs - clip.inMs)
						: clip.startMs + 1;
				const max =
					active.mode === "in"
						? end - 1
						: Math.min(
								active.base.durationMs,
								clip.startMs +
									availableSourceDuration(
										source,
										active.track,
										active.base.audioEnabled,
									) -
									clip.inMs,
							);
				active.snapMs = snapTimelineTime(
					edge + delta,
					active.candidates.filter((time) => time >= min && time <= max),
					active.pixelsPerMs,
					previousSnap,
				);
				if (active.snapMs !== null) snappedDelta = active.snapMs - edge;
			}
			active.next = trim(
				active.base,
				active.id,
				active.track,
				active.linked,
				active.mode,
				snappedDelta,
				active.snapMs !== null,
			);
			const edited = timelineItems(active.next, active.track).find(
				(item) => item.clip.id === active.id,
			)?.clip;
			const actualEdge =
				edited &&
				(active.mode === "in"
					? edited.startMs
					: edited.startMs + edited.outMs - edited.inMs);
			if (actualEdge !== active.snapMs) active.snapMs = null;
		}
		active.extentMs = Math.max(active.extentMs, timelineDuration(active.next));
		setShown({
			next: active.next,
			extentMs: active.extentMs,
			snapMs: active.snapMs,
		});
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
				const captureTarget = track.current;
				const bounds = captureTarget?.getBoundingClientRect(),
					total = timelineDuration(document);
				if (!captureTarget || !bounds || !pixelsPerMs || !total) return;
				focusAfter.current = null;
				event.preventDefault();
				event.currentTarget.focus();
				onSelect(id, medium);
				captureTarget.setPointerCapture(event.pointerId);
				gesture.current = {
					id,
					track: medium,
					mode,
					linked: linked && !!linkedPartner(document, { track: medium, id }),
					pointer: event.pointerId,
					x: event.clientX - bounds.left,
					clientX: event.clientX,
					pixelsPerMs,
					extentMs: total,
					snapMs: null,
					snapEdge: null,
					dragged: false,
					candidates: timelineSnapCandidates(
						document,
						{ track: medium, id },
						positionMs,
					),
					target: captureTarget,
					focusTarget: event.currentTarget,
					base: document,
					next: document,
				};
				setShown({ next: document, extentMs: total, snapMs: null });
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
				const targetLinked =
					linked && !!linkedPartner(document, { track: medium, id });
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
								{ track: medium, linked: targetLinked },
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
				const sourceDuration = availableSourceDuration(
					fact,
					targetLinked ? "both" : medium,
					document.audioEnabled,
				);
				const delta =
					event.key === "Home"
						? -sourceDuration
						: event.key === "End"
							? sourceDuration
							: (event.key === "ArrowLeft" ? -1 : 1) *
								tick *
								(event.shiftKey ? 10 : 1);
				onChange(trim(document, id, medium, targetLinked, mode, delta));
			},
		};
	}
	const pointerHandlers = {
		onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
			move(event.pointerId, event.clientX, event.altKey);
		},
		onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
			const active = gesture.current;
			if (!active || active.pointer !== event.pointerId) return;
			move(event.pointerId, event.clientX, event.altKey);
			if (gesture.current !== active) return;
			let seekTo: number | undefined;
			if (
				active.mode === "move" &&
				!active.dragged &&
				active.next === active.base
			) {
				const item = timelineItems(active.base, active.track).find(
					(item) => item.clip.id === active.id,
				);
				if (item)
					seekTo = Math.max(
						item.startMs,
						Math.min(
							item.startMs + item.durationMs - 1,
							Math.round(
								(event.clientX - active.target.getBoundingClientRect().left) /
									active.pixelsPerMs,
							),
						),
					);
			}
			finish(true);
			if (seekTo !== undefined) onSeek(seekTo);
		},
		onPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
			if (gesture.current?.pointer === event.pointerId) finish(false);
		},
		onLostPointerCapture(event: React.PointerEvent<HTMLDivElement>) {
			if (
				gesture.current?.pointer === event.pointerId &&
				event.target === gesture.current.target
			)
				finish(false);
		},
	};
	return {
		shown: shown?.next ?? document,
		extentMs: shown?.extentMs ?? timelineDuration(document),
		dragging: shown !== null,
		snapMs: shown?.snapMs ?? null,
		handlers,
		pointerHandlers,
	};
}
