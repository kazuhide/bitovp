"use client";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { EditingDetails, EditingHelp } from "../../editing-help";
import {
	type CropHandle,
	type CropOverlayRect,
	type CropSourceSize,
	cropFromDelta,
	cropFromKey,
	isCropOverlayRect,
	sameCropOverlayRect,
} from "./crop-overlay-geometry";
import { useSourceCropCopy } from "./source-crop-copy";

export type SourceCropEditorProps = {
	canvasRef: RefObject<HTMLCanvasElement | null>;
	sourceSize: CropSourceSize | null;
	rect: CropOverlayRect | null;
	ready: boolean;
	playing: boolean;
	disabled: boolean;
	contextKey: string;
	onStart(): boolean;
	onPreview(rect: CropOverlayRect): void;
	onCommit(rect: CropOverlayRect): void;
	onCancel(): void;
};
type Gesture = {
	kind: "pointer" | "keyboard";
	handle: CropHandle;
	target: HTMLButtonElement;
	canvas: HTMLCanvasElement;
	contextKey: string;
	source: CropSourceSize;
	base: CropOverlayRect;
	next: CropOverlayRect;
	box: { left: number; top: number; width: number; height: number };
	pointer?: number;
	x: number;
	y: number;
	published?: CropOverlayRect;
	pending: boolean;
	raf?: number;
};
const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/** Controlled overlay: only the parent's accepted rect is ever drawn. */
export function SourceCropEditor(props: SourceCropEditorProps) {
	const c = useSourceCropCopy(),
		helpId = useId();
	const latest = useRef(props);
	latest.current = props;
	const gesture = useRef<Gesture | null>(null);
	const [active, setActive] = useState<Gesture["kind"] | null>(null);
	const [{ compact, tool }, setControls] = useState({
		compact: false,
		tool: "move" as "move" | "size",
	});
	const [announcement, setAnnouncement] = useState("");
	const messages = useRef(c);
	messages.current = c;
	const editable =
		props.ready &&
		!props.playing &&
		!props.disabled &&
		isCropOverlayRect(props.rect, props.sourceSize);
	const visible = props.sourceSize !== null && props.rect !== null;
	const measureControls = useCallback(
		(rect: CropOverlayRect | null, source: CropSourceSize | null) => {
			if (gesture.current) return;
			const canvas = latest.current.canvasRef.current;
			let compact = false;
			if (canvas && isCropOverlayRect(rect, source)) {
				const box = canvas.getBoundingClientRect();
				compact =
					box.width > 0 &&
					box.height > 0 &&
					box.width * rect.w < 88 &&
					box.height * rect.h < 88;
			}
			setControls((current) =>
				current.compact === compact ? current : { compact, tool: "move" },
			);
		},
		[],
	);
	useEffect(() => {
		if (!active) measureControls(props.rect, props.sourceSize);
	}, [active, props.rect, props.sourceSize, measureControls]);
	useEffect(() => {
		const canvas = props.canvasRef.current;
		if (!canvas) return;
		const measure = () => {
			const current = latest.current;
			measureControls(current.rect, current.sourceSize);
		};
		measure();
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(canvas);
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [props.canvasRef, measureControls]);
	const valid = useCallback((g: Gesture) => {
		const p = latest.current,
			box = g.canvas.getBoundingClientRect();
		return (
			p.ready &&
			!p.playing &&
			!p.disabled &&
			p.contextKey === g.contextKey &&
			p.canvasRef.current === g.canvas &&
			p.sourceSize?.width === g.source.width &&
			p.sourceSize.height === g.source.height &&
			isCropOverlayRect(p.rect, p.sourceSize) &&
			(["left", "top", "width", "height"] as const).every(
				(key) => Math.abs(box[key] - g.box[key]) < 0.5,
			)
		);
	}, []);
	const flush = useCallback(
		(g: Gesture) => {
			if (gesture.current !== g || !valid(g)) return;
			g.pending = false;
			if (!g.published || !sameCropOverlayRect(g.published, g.next)) {
				g.published = g.next;
				latest.current.onPreview(g.next);
			}
		},
		[valid],
	);
	const finish = useCallback(
		(commit: boolean) => {
			const g = gesture.current;
			if (!g) return;
			if (g.raf !== undefined) cancelAnimationFrame(g.raf);
			g.raf = undefined;
			const changed = !sameCropOverlayRect(g.base, g.next);
			if (commit && changed && valid(g)) flush(g);
			if (gesture.current !== g) return;
			const accepted = commit && changed && valid(g);
			gesture.current = null;
			setActive(null);
			if (g.pointer !== undefined && g.target.hasPointerCapture?.(g.pointer))
				g.target.releasePointerCapture(g.pointer);
			if (accepted) {
				latest.current.onCommit(g.next);
				setAnnouncement(messages.current.changed);
			} else {
				latest.current.onCancel();
				setAnnouncement(messages.current.canceled);
			}
		},
		[flush, valid],
	);
	const schedule = (g: Gesture) => {
		g.pending = true;
		if (g.raf !== undefined) return;
		g.raf = requestAnimationFrame(() => {
			g.raf = undefined;
			if (gesture.current !== g) return;
			if (!valid(g)) finish(false);
			else flush(g);
		});
	};
	useEffect(() => {
		const g = gesture.current;
		if (
			g &&
			(props.contextKey !== g.contextKey ||
				props.disabled ||
				props.playing ||
				!props.ready ||
				props.sourceSize?.width !== g.source.width ||
				props.sourceSize.height !== g.source.height ||
				!valid(g))
		)
			finish(false);
	}, [
		props.contextKey,
		props.disabled,
		props.playing,
		props.ready,
		props.sourceSize?.width,
		props.sourceSize?.height,
		finish,
		valid,
	]);
	useEffect(() => {
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && gesture.current) {
				event.preventDefault();
				finish(false);
			}
		};
		const cancel = () => finish(false);
		window.addEventListener("keydown", handleEscape);
		window.addEventListener("blur", cancel);
		window.addEventListener("resize", cancel);
		return () => {
			window.removeEventListener("keydown", handleEscape);
			window.removeEventListener("blur", cancel);
			window.removeEventListener("resize", cancel);
			finish(false);
		};
	}, [finish]);
	function start(
		target: HTMLButtonElement,
		handle: CropHandle,
		kind: Gesture["kind"],
		x = 0,
		y = 0,
		pointer?: number,
	) {
		const p = latest.current,
			canvas = p.canvasRef.current,
			source = p.sourceSize,
			rect = p.rect;
		if (
			gesture.current ||
			!editable ||
			(compact &&
				((tool === "size" && handle === "move") ||
					(tool === "move" && handle !== "move"))) ||
			!canvas ||
			!source ||
			!isCropOverlayRect(rect, source)
		)
			return null;
		const box = canvas.getBoundingClientRect();
		if (box.width <= 0 || box.height <= 0 || !p.onStart()) return null;
		const g: Gesture = {
			kind,
			handle,
			target,
			canvas,
			source: { ...source },
			contextKey: p.contextKey,
			base: { ...rect },
			next: { ...rect },
			box,
			pointer,
			x,
			y,
			pending: false,
		};
		gesture.current = g;
		setActive(kind);
		setAnnouncement("");
		try {
			target.focus();
			if (pointer !== undefined) target.setPointerCapture(pointer);
		} catch {
			finish(false);
			return null;
		}
		return g;
	}
	function move(pointer: number, x: number, y: number) {
		const g = gesture.current;
		if (g?.kind !== "pointer" || g.pointer !== pointer) return;
		if (!valid(g)) {
			finish(false);
			return;
		}
		g.next = cropFromDelta(
			g.base,
			g.handle,
			(x - g.x) / g.box.width,
			(y - g.y) / g.box.height,
			g.source,
		);
		schedule(g);
	}
	const handlers = (handle: CropHandle) => ({
		onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
			if (event.button !== 0 || event.isPrimary === false) return;
			if (
				start(
					event.currentTarget,
					handle,
					"pointer",
					event.clientX,
					event.clientY,
					event.pointerId,
				)
			)
				event.preventDefault();
		},
		onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
			move(event.pointerId, event.clientX, event.clientY);
		},
		onPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
			if (gesture.current?.pointer !== event.pointerId) return;
			move(event.pointerId, event.clientX, event.clientY);
			finish(true);
		},
		onPointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
			if (gesture.current?.pointer === event.pointerId) finish(false);
		},
		onLostPointerCapture(event: React.PointerEvent<HTMLButtonElement>) {
			if (gesture.current?.pointer === event.pointerId) finish(false);
		},
		onBlur() {
			if (gesture.current?.kind === "keyboard") finish(false);
		},
		onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
			if (
				!arrows.includes(event.key) ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				!editable
			)
				return;
			event.preventDefault();
			const g =
				gesture.current ?? start(event.currentTarget, handle, "keyboard");
			if (g?.kind !== "keyboard" || g.handle !== handle || !valid(g)) return;
			const accepted = latest.current.rect;
			const base = g.pending || !accepted ? g.next : accepted;
			const next = cropFromKey(
				base,
				handle,
				event.key,
				event.shiftKey,
				g.source,
			);
			if (next) {
				g.next = next;
				schedule(g);
			}
		},
		onKeyUp(event: React.KeyboardEvent<HTMLButtonElement>) {
			if (
				arrows.includes(event.key) &&
				gesture.current?.kind === "keyboard" &&
				gesture.current.handle === handle
			) {
				event.preventDefault();
				finish(true);
			}
		},
	});
	const rect = isCropOverlayRect(props.rect, props.sourceSize)
		? props.rect
		: null;
	const help = compact ? (tool === "move" ? c.moveHelp : c.sizeHelp) : c.help;
	const corners = ["nw", "ne", "sw", "se"] as const;
	return (
		<section
			className="min-w-0 space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4"
			aria-label={c.sourceTitle}
			data-gesture={active ?? "idle"}
		>
			<div className="flex min-h-5 flex-wrap items-center justify-between gap-2">
				<div className="flex shrink-0 items-center gap-1">
					<h2 className="font-medium text-sm">{c.sourceTitle}</h2>
					<EditingHelp label={c.sourceTitle}>
						<p>{help}</p>
						<p>{c.scope}</p>
					</EditingHelp>
				</div>
				{compact && (
					<fieldset
						aria-label={c.tools}
						className="m-0 flex min-w-0 shrink-0 gap-1 border-0 p-0"
					>
						{(["move", "size"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								data-crop-tool={mode}
								aria-pressed={tool === mode}
								disabled={!editable || active !== null}
								className={`h-11 w-11 shrink-0 whitespace-nowrap rounded-md border text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-default disabled:opacity-50 ${tool === mode ? "border-emerald-600 bg-emerald-950 text-emerald-200" : "border-zinc-700 text-zinc-400"}`}
								onClick={() => {
									if (!editable || gesture.current) return;
									setControls((current) =>
										current.tool === mode
											? current
											: { ...current, tool: mode },
									);
								}}
							>
								{mode === "move" ? c.moveTool : c.sizeTool}
							</button>
						))}
					</fieldset>
				)}
			</div>
			<div
				data-testid="source-crop-stage"
				className="relative rounded-lg bg-black"
				style={{
					aspectRatio: props.sourceSize
						? `${props.sourceSize.width}/${props.sourceSize.height}`
						: "16/9",
				}}
			>
				<canvas
					ref={props.canvasRef}
					data-testid="source-crop-canvas"
					width={1}
					height={1}
					aria-hidden="true"
					tabIndex={-1}
					className={`absolute inset-0 h-full w-full rounded-lg ${visible ? "" : "invisible"}`}
				/>
				{visible && rect && (
					<>
						<svg
							className="pointer-events-none absolute inset-0 h-full w-full rounded-lg"
							viewBox="0 0 1 1"
							preserveAspectRatio="none"
							aria-hidden="true"
						>
							<path
								fill="rgb(0 0 0 / 0.4)"
								fillRule="evenodd"
								d={`M0 0H1V1H0Z M${rect.x} ${rect.y}H${rect.x + rect.w}V${rect.y + rect.h}H${rect.x}Z`}
							/>
						</svg>
						<button
							type="button"
							data-crop-handle="move"
							aria-label={c.move}
							aria-describedby={helpId}
							disabled={!editable || (compact && tool === "size")}
							className="absolute touch-none cursor-move border-2 border-emerald-400 bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-default"
							style={{
								left: `${rect.x * 100}%`,
								top: `${rect.y * 100}%`,
								width: `${rect.w * 100}%`,
								height: `${rect.h * 100}%`,
								pointerEvents: compact && tool === "size" ? "none" : "auto",
							}}
							{...handlers("move")}
						/>
						{(!compact || tool === "size") &&
							corners.map((corner) => (
								<button
									key={corner}
									type="button"
									data-crop-handle={corner}
									aria-label={c[corner]}
									aria-describedby={helpId}
									disabled={!editable}
									className="absolute z-10 flex h-11 w-11 touch-none items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-default"
									style={{
										left: `${(rect.x + (corner.endsWith("e") ? rect.w : 0)) * 100}%`,
										top: `${(rect.y + (corner.startsWith("s") ? rect.h : 0)) * 100}%`,
										transform: "translate(-50%, -50%)",
										cursor:
											corner === "nw" || corner === "se"
												? "nwse-resize"
												: "nesw-resize",
									}}
									{...handlers(corner)}
								>
									<span
										aria-hidden="true"
										className="h-2.5 w-2.5 rounded-sm border border-zinc-950 bg-emerald-300"
									/>
								</button>
							))}
					</>
				)}
				{!visible && (
					<p
						role="status"
						className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-zinc-400"
					>
						{props.sourceSize ? c.waiting : c.chooseClip}
					</p>
				)}
			</div>
			{visible && (
				<p
					id={helpId}
					className="text-pretty text-xs leading-relaxed text-zinc-400"
				>
					{props.playing
						? c.paused
						: props.disabled
							? c.locked
							: !props.ready
								? c.waiting
								: help}
				</p>
			)}
			<EditingDetails summary={c.details}>
				<p>{c.scope}</p>
				<p>{c.keyboard}</p>
				<p>{c.lockedHelp}</p>
			</EditingDetails>
			<span role="status" className="sr-only">
				{announcement}
			</span>
		</section>
	);
}
