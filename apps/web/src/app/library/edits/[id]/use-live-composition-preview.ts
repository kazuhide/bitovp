import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildPreviewPlan, previewLocation } from "../preview-model";
import type { LiveCompositionPreviewProps } from "./live-composition-preview";
import {
	LivePreviewTransport,
	type PreviewSnapshot,
} from "./live-preview-transport";

export function useLiveCompositionPreview(props: LiveCompositionPreviewProps) {
	const video = useRef<HTMLVideoElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const controller = useRef<LivePreviewTransport | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const plan = useMemo(() => {
		try {
			return buildPreviewPlan(props.document, props.media);
		} catch {
			return null;
		}
	}, [props.document, props.media]);
	const currentPlan = useRef(plan);
	currentPlan.current = plan;
	const [snapshot, setSnapshot] = useState<PreviewSnapshot>({
		phase: "loading",
		frame: 0,
		playing: false,
		muted: true,
		clipMuted: false,
		loop: false,
		rate: 1,
	});
	useLayoutEffect(() => {
		const element = video.current;
		if (!element) return;
		const transport = new LivePreviewTransport(element, {
			onFrameChange: (frame) => latest.current.onFrameChange(frame),
			onSnapshot: setSnapshot,
			onDraw: (frame, plan) => {
				const output = canvas.current;
				const context = output?.getContext("2d");
				if (!output || !context) throw new Error("Preview canvas unavailable");
				const { width, height } = plan.document.canvas;
				if (output.width !== width) output.width = width;
				if (output.height !== height) output.height = height;
				const g = previewLocation(plan, frame).geometry;
				context.fillStyle = "black";
				context.fillRect(0, 0, width, height);
				context.drawImage(
					element,
					g.sx,
					g.sy,
					g.sw,
					g.sh,
					g.dx,
					g.dy,
					g.dw,
					g.dh,
				);
			},
		});
		controller.current = transport;
		transport.update(
			currentPlan.current,
			latest.current.frame,
			latest.current.blocked,
			latest.current.pauseSignal,
			latest.current.seekSignal,
		);
		const visibility = () =>
			transport.setVisible(document.visibilityState !== "hidden");
		const hide = () => transport.setVisible(false);
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("pagehide", hide);
		window.addEventListener("pageshow", visibility);
		visibility();
		return () => {
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("pagehide", hide);
			window.removeEventListener("pageshow", visibility);
			transport.destroy();
			controller.current = null;
		};
	}, []);
	useLayoutEffect(() => {
		controller.current?.update(
			plan,
			props.frame,
			props.blocked,
			props.pauseSignal,
			props.seekSignal,
		);
	}, [plan, props.frame, props.blocked, props.pauseSignal, props.seekSignal]);
	return { video, canvas, controller, plan, snapshot };
}
