import type { CfrTimeMap, EditDocument } from "@bitovp/core";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { type TrimEdge, trimTimelineClip } from "../timeline-model";

export type TimelineProps = {
	document: EditDocument;
	map: CfrTimeMap | null;
	positionFrame: number;
	selectedClipId: string | null;
	disabled: boolean;
	rangePending: boolean;
	onSeek: (frame: number) => void;
	onSelectClip: (clipId: string) => void;
	onChange: (next: EditDocument) => void;
	onPending: (clipId: string, pending: boolean) => void;
};
type Gesture = {
	index: number;
	edge: TrimEdge;
	pointer: number;
	x: number;
	pixelsPerFrame: number;
	base: EditDocument;
	next: EditDocument;
	target: HTMLDivElement;
};

/** Own the pointer capture and publish a single edit only after release. */
export function useTimelineTrim(
	props: TimelineProps,
	track: RefObject<HTMLDivElement | null>,
) {
	const { document, map, disabled, rangePending } = props;
	const latest = useRef(props);
	latest.current = props;
	const gesture = useRef<Gesture | null>(null);
	const [preview, setPreview] = useState<EditDocument | null>(null);
	const [error, setError] = useState(false);
	const finish = useCallback((commit: boolean) => {
		const current = gesture.current;
		if (!current) return;
		gesture.current = null;
		setPreview(null);
		const props = latest.current;
		const clip = current.base.clips[current.index];
		if (clip) props.onPending(`timeline:${clip.id}`, false);
		if (current.target.hasPointerCapture?.(current.pointer))
			current.target.releasePointerCapture(current.pointer);
		if (
			commit &&
			!props.disabled &&
			!props.rangePending &&
			props.document === current.base &&
			current.next !== current.base
		)
			props.onChange(current.next);
	}, []);
	useEffect(() => {
		if (
			disabled ||
			rangePending ||
			(gesture.current && document !== gesture.current.base)
		)
			finish(false);
	}, [disabled, rangePending, document, finish]);
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
			const current = gesture.current;
			const clip = current?.base.clips[current.index];
			if (clip) latest.current.onPending(`timeline:${clip.id}`, false);
		};
	}, [finish]);
	function trim(index: number, edge: TrimEdge, delta: number, base = document) {
		if (!map) return base;
		try {
			const next = trimTimelineClip(base, index, edge, delta, map);
			setError(false);
			return next;
		} catch {
			setError(true);
			return base;
		}
	}
	function move(pointer: number, clientX: number) {
		const current = gesture.current;
		if (!current || current.pointer !== pointer) return;
		if (disabled || rangePending || document !== current.base) {
			finish(false);
			return;
		}
		current.next = trim(
			current.index,
			current.edge,
			Math.round((clientX - current.x) / current.pixelsPerFrame),
			current.base,
		);
		setPreview(current.next);
	}
	function trimHandlers(index: number, edge: TrimEdge) {
		return {
			onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
				if (disabled || rangePending || !map || gesture.current) return;
				if (
					![
						"ArrowLeft",
						"ArrowRight",
						"ArrowUp",
						"ArrowDown",
						"Home",
						"End",
					].includes(event.key)
				)
					return;
				event.preventDefault();
				const direction = ["ArrowLeft", "ArrowDown"].includes(event.key)
					? -1
					: 1;
				const delta =
					event.key === "Home"
						? -map.editingEndFrame
						: event.key === "End"
							? map.editingEndFrame
							: direction * (event.shiftKey ? 10 : 1);
				const next = trim(index, edge, delta);
				if (next !== document) latest.current.onChange(next);
			},
			onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
				if (
					disabled ||
					rangePending ||
					!map ||
					gesture.current ||
					event.button !== 0
				)
					return;
				const clip = document.clips[index];
				const total = document.clips.reduce(
					(sum, item) => sum + item.durationFrames,
					0,
				);
				const width = track.current?.getBoundingClientRect().width ?? 0;
				if (!clip || width <= 0 || total < 1) return;
				event.preventDefault();
				event.currentTarget.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
				gesture.current = {
					index,
					edge,
					pointer: event.pointerId,
					x: event.clientX,
					pixelsPerFrame: width / total,
					base: document,
					next: document,
					target: event.currentTarget,
				};
				setPreview(document);
				latest.current.onPending(`timeline:${clip.id}`, true);
			},
			onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
				move(event.pointerId, event.clientX);
			},
			onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
				if (gesture.current?.pointer !== event.pointerId) return;
				move(event.pointerId, event.clientX);
				finish(true);
			},
			onPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
				if (gesture.current?.pointer === event.pointerId) finish(false);
			},
			onLostPointerCapture(event: React.PointerEvent<HTMLDivElement>) {
				if (gesture.current?.pointer === event.pointerId) finish(false);
			},
		};
	}
	return {
		shown: preview ?? document,
		dragging: preview !== null,
		activeIndex: gesture.current?.index,
		error,
		trimHandlers,
	};
}
