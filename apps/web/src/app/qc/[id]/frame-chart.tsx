"use client";

import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Brush,
	CartesianGrid,
	Line,
	LineChart,
	ReferenceDot,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useT } from "@/lib/i18n/context";
import {
	anyHasPsnr,
	renditionColor,
	renditionLabel,
	VMAF_AXIS_MAX,
	type VmafResultDetail,
} from "../vmaf-shared";

/**
 * One x-position (frameNum) with each rendition's scores. VMAF lives under
 * the bare series key; PSNR (when present) under `${key}__psnr`.
 */
type MergedPoint = { frameNum: number } & Record<string, number | undefined>;

/** Stable per-rendition series key (dataKey) — id keeps it unique. */
function seriesKey(r: VmafResultDetail): string {
	return `r_${r.id}`;
}
/** PSNR companion series key for a rendition. */
function psnrKey(r: VmafResultDetail): string {
	return `${seriesKey(r)}__psnr`;
}

/**
 * Per-frame time series — one overlaid VMAF line per rendition over the
 * DOWNSAMPLED series (the route already pinned each run's worst frame). The
 * worst frame per rendition is marked with a ReferenceDot. A Brush gives
 * pan/zoom without over-engineering. The left y-axis is locked to the VMAF
 * 0–100 domain so renditions are visually comparable.
 *
 * When the run carries PSNR (P4-PR5), a "Show PSNR" toggle reveals a SECOND
 * (right) y-axis in dB and a dashed PSNR line per rendition — PSNR is a
 * different scale (~20–60 dB) so it cannot share the VMAF axis. VMAF-only is
 * the default view; the toggle only appears when PSNR data exists.
 *
 * Recharts measures via ResponsiveContainer (no width in jsdom) — render
 * inside a fixed-height box and pass an explicit test width where needed.
 */
export function FrameChart({
	results,
	selectedFrame,
	onFrameSelect,
}: {
	results: VmafResultDetail[];
	selectedFrame?: number;
	onFrameSelect?: (frame: number) => void;
}) {
	const { t } = useT();
	const hasPsnr = anyHasPsnr(results);
	const [showPsnr, setShowPsnr] = useState(false);
	const psnrVisible = hasPsnr && showPsnr;

	// Merge every rendition's frames onto a shared frameNum axis. Series are
	// downsampled independently, so union the x-values and leave gaps (undefined)
	// where a rendition has no sample — Recharts connects across nulls per line.
	const data = useMemo<MergedPoint[]>(() => {
		const byFrame = new Map<number, MergedPoint>();
		for (const r of results) {
			const vKey = seriesKey(r);
			const pKey = psnrKey(r);
			for (const f of r.frames) {
				let point = byFrame.get(f.frameNum);
				if (!point) {
					point = { frameNum: f.frameNum };
					byFrame.set(f.frameNum, point);
				}
				point[vKey] = f.vmaf;
				if (typeof f.psnr === "number") {
					point[pKey] = f.psnr;
				}
			}
		}
		return [...byFrame.values()].sort((a, b) => a.frameNum - b.frameNum);
	}, [results]);
	const minFrame = data[0]?.frameNum ?? 0;
	const maxFrame = data.at(-1)?.frameNum ?? minFrame;
	const [startFrame, setStartFrame] = useState(() => String(minFrame));
	const [endFrame, setEndFrame] = useState(() => String(maxFrame));
	const [brushRange, setBrushRange] = useState(() => ({
		startIndex: 0,
		endIndex: Math.max(0, data.length - 1),
	}));
	const startId = useId();
	const endId = useId();
	const rangeStatusId = useId();
	const chartRef = useRef<HTMLDivElement>(null);

	// A report can finish loading while this component stays mounted. Reset the
	// canonical controls to the new data bounds instead of retaining stale indices.
	useEffect(() => {
		setStartFrame(String(minFrame));
		setEndFrame(String(maxFrame));
		setBrushRange({ startIndex: 0, endIndex: Math.max(0, data.length - 1) });
	}, [data.length, maxFrame, minFrame]);

	const parsedStart =
		startFrame.trim() === "" ? Number.NaN : Number(startFrame);
	const parsedEnd = endFrame.trim() === "" ? Number.NaN : Number(endFrame);
	const outsideBounds =
		!Number.isInteger(parsedStart) ||
		!Number.isInteger(parsedEnd) ||
		parsedStart < minFrame ||
		parsedStart > maxFrame ||
		parsedEnd < minFrame ||
		parsedEnd > maxFrame;
	const inverted = !outsideBounds && parsedStart > parsedEnd;
	const rangeInvalid = outsideBounds || inverted;

	function applyDraft(nextStart: string, nextEnd: string) {
		const start = nextStart.trim() === "" ? Number.NaN : Number(nextStart);
		const end = nextEnd.trim() === "" ? Number.NaN : Number(nextEnd);
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < minFrame ||
			start > maxFrame ||
			end < minFrame ||
			end > maxFrame ||
			start > end
		) {
			return;
		}
		const startIndex = data.findIndex((point) => point.frameNum >= start);
		let endIndex = data.findLastIndex((point) => point.frameNum <= end);
		if (startIndex < 0) return;
		if (endIndex < startIndex) endIndex = startIndex;
		setBrushRange({ startIndex, endIndex });
	}

	const removeDuplicateBrushStops = useCallback(() => {
		for (const handle of chartRef.current?.querySelectorAll(
			".recharts-brush-traveller",
		) ?? []) {
			if (handle.getAttribute("tabindex") !== "-1") {
				handle.setAttribute("tabindex", "-1");
			}
			if (handle.getAttribute("aria-hidden") !== "true") {
				handle.setAttribute("aria-hidden", "true");
			}
		}
	}, []);
	useLayoutEffect(removeDuplicateBrushStops, [removeDuplicateBrushStops]);
	useEffect(() => {
		const root = chartRef.current;
		if (!root || typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver(removeDuplicateBrushStops);
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["tabindex"],
			childList: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, [removeDuplicateBrushStops]);

	const withFrames = results.filter((r) => r.frames.length > 0);
	if (withFrames.length === 0) {
		return <p className="mt-2 text-sm text-zinc-500">{t("qc.noFrameData")}</p>;
	}

	return (
		<>
			{hasPsnr ? (
				<div className="mt-2 flex justify-end">
					<button
						type="button"
						onClick={() => setShowPsnr((v) => !v)}
						aria-pressed={psnrVisible}
						className={`rounded border px-2 py-1 text-xs transition-colors ${
							psnrVisible
								? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
								: "border-zinc-700 text-zinc-400 hover:text-zinc-200"
						}`}
					>
						{psnrVisible ? t("qc.hidePsnr") : t("qc.showPsnr")}
					</button>
				</div>
			) : null}
			<div className="mt-2 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
				<label htmlFor={startId} className="grid gap-1 text-xs text-zinc-400">
					{t("qc.startFrame")}
					<input
						id={startId}
						type="number"
						min={minFrame}
						max={maxFrame}
						step={1}
						value={startFrame}
						aria-invalid={rangeInvalid}
						aria-describedby={rangeStatusId}
						className="h-11 w-32 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 tabular-nums"
						onChange={(event) => {
							const value = event.target.value;
							setStartFrame(value);
							applyDraft(value, endFrame);
						}}
					/>
				</label>
				<label htmlFor={endId} className="grid gap-1 text-xs text-zinc-400">
					{t("qc.endFrame")}
					<input
						id={endId}
						type="number"
						min={minFrame}
						max={maxFrame}
						step={1}
						value={endFrame}
						aria-invalid={rangeInvalid}
						aria-describedby={rangeStatusId}
						className="h-11 w-32 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 tabular-nums"
						onChange={(event) => {
							const value = event.target.value;
							setEndFrame(value);
							applyDraft(startFrame, value);
						}}
					/>
				</label>
				<p
					id={rangeStatusId}
					role="status"
					aria-live="polite"
					aria-atomic="true"
					className={
						rangeInvalid ? "text-red-400 text-xs" : "text-zinc-400 text-xs"
					}
				>
					{inverted
						? t("qc.frameRangeInvalid")
						: outsideBounds
							? t("qc.frameRangeOutOfBounds", {
									min: minFrame,
									max: maxFrame,
								})
							: t("qc.frameRangeCurrent", {
									start: parsedStart,
									end: parsedEnd,
								})}
				</p>
			</div>
			<div
				ref={chartRef}
				className="mt-2 h-80 w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2"
			>
				<ResponsiveContainer
					width="100%"
					height="100%"
					initialDimension={{ width: 0, height: 302 }}
				>
					<LineChart
						data={data}
						onClick={(state) => {
							const frame = Number(state.activeLabel);
							if (
								state.activeLabel != null &&
								Number.isInteger(frame) &&
								frame >= minFrame &&
								frame <= maxFrame
							)
								onFrameSelect?.(frame);
						}}
						margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
					>
						<CartesianGrid
							stroke="var(--color-zinc-800)"
							strokeDasharray="3 3"
						/>
						{selectedFrame !== undefined ? (
							<ReferenceLine
								yAxisId="vmaf"
								x={selectedFrame}
								stroke="var(--color-zinc-200)"
								strokeDasharray="3 3"
							/>
						) : null}
						<XAxis
							dataKey="frameNum"
							type="number"
							domain={["dataMin", "dataMax"]}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							label={{
								value: "frame",
								position: "insideBottomRight",
								fill: "var(--color-zinc-600)",
								fontSize: 11,
							}}
						/>
						<YAxis
							yAxisId="vmaf"
							domain={[0, VMAF_AXIS_MAX]}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							width={36}
						/>
						{psnrVisible ? (
							<YAxis
								yAxisId="psnr"
								orientation="right"
								domain={["dataMin - 2", "dataMax + 2"]}
								stroke="var(--color-zinc-500)"
								tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
								tickLine={false}
								width={40}
								label={{
									value: t("ui.psnrDb2"),
									angle: 90,
									position: "insideRight",
									fill: "var(--color-zinc-500)",
									fontSize: 10,
								}}
							/>
						) : null}
						<Tooltip
							contentStyle={{
								background: "var(--color-zinc-900)",
								border: "1px solid var(--color-zinc-700)",
								borderRadius: 6,
								fontSize: 12,
							}}
							labelStyle={{ color: "var(--color-zinc-200)" }}
							labelFormatter={(v) => `frame ${v}`}
							formatter={(value, name) => [
								typeof value === "number" ? value.toFixed(1) : value,
								name,
							]}
						/>
						{withFrames.map((r) => {
							const idx = results.indexOf(r);
							return (
								<Line
									key={r.id}
									yAxisId="vmaf"
									type="monotone"
									dataKey={seriesKey(r)}
									name={renditionLabel(r.renditionRef, idx)}
									stroke={renditionColor(idx)}
									strokeWidth={1.5}
									dot={false}
									connectNulls
									isAnimationActive={false}
								/>
							);
						})}
						{psnrVisible
							? withFrames.map((r) => {
									const idx = results.indexOf(r);
									return (
										<Line
											key={`psnr-${r.id}`}
											yAxisId="psnr"
											type="monotone"
											dataKey={psnrKey(r)}
											name={t("uiX.psnrForRendition", {
												rendition: renditionLabel(r.renditionRef, idx),
											})}
											stroke={renditionColor(idx)}
											strokeWidth={1}
											strokeDasharray="4 3"
											dot={false}
											connectNulls
											isAnimationActive={false}
										/>
									);
								})
							: null}
						{withFrames.map((r) => {
							const idx = results.indexOf(r);
							const worst = r.pooled.worstFrame;
							return (
								<ReferenceDot
									key={`worst-${r.id}`}
									yAxisId="vmaf"
									x={worst.frameNum}
									y={worst.vmaf}
									r={4}
									fill={renditionColor(idx)}
									stroke="var(--color-zinc-50)"
									strokeWidth={1}
									ifOverflow="extendDomain"
								/>
							);
						})}
						<Brush
							dataKey="frameNum"
							startIndex={brushRange.startIndex}
							endIndex={brushRange.endIndex}
							onChange={(next) => {
								if (
									typeof next.startIndex !== "number" ||
									typeof next.endIndex !== "number"
								) {
									return;
								}
								setBrushRange({
									startIndex: next.startIndex,
									endIndex: next.endIndex,
								});
								setStartFrame(
									String(data[next.startIndex]?.frameNum ?? minFrame),
								);
								setEndFrame(String(data[next.endIndex]?.frameNum ?? maxFrame));
							}}
							height={20}
							stroke="var(--color-zinc-700)"
							fill="var(--color-zinc-900)"
							travellerWidth={8}
							tickFormatter={(v) => `${v}`}
						/>
					</LineChart>
				</ResponsiveContainer>
			</div>
		</>
	);
}
