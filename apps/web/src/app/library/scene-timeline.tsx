"use client";
import type { SceneAnalysisDocument } from "@bitovp/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import { SceneNavigator } from "./scene-navigator";

const tensionStyles: Record<string, { height: number; color: string }> = {
	LOW: { height: 8, color: "bg-blue-400/60" },
	MODERATE: { height: 28, color: "bg-emerald-400/60" },
	HIGH: { height: 58, color: "bg-amber-400/60" },
	EXTREME: { height: 95, color: "bg-red-400/60" },
};
const sceneTypes: Record<string, string> = {
	OPENING_CREDITS: "bg-blue-950",
	END_CREDITS: "bg-purple-950",
	BREAK_BUMPER: "bg-amber-950",
	PREVIEW_THIS_TITLE: "bg-purple-950",
};
export function clockTime(seconds: number) {
	return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
		.toString()
		.padStart(2, "0")}`;
}

// Follow horizontally inside this strip only; never pull the page or focused reader.
function useFollow(active: string | number | undefined) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (active === undefined) return;
		const parent = ref.current;
		const child = parent?.querySelector<HTMLElement>('[aria-current="true"]');
		if (
			!parent ||
			!child ||
			parent.matches(":hover") ||
			parent.contains(document.activeElement)
		)
			return;
		const left = child.offsetLeft - parent.offsetLeft;
		if (left < parent.scrollLeft) parent.scrollLeft = left;
		else if (left + child.offsetWidth > parent.scrollLeft + parent.clientWidth)
			parent.scrollLeft = left + child.offsetWidth - parent.clientWidth;
	}, [active]);
	return ref;
}

function SceneStrip({
	active,
	children,
}: {
	active?: string;
	children: ReactNode;
}) {
	const ref = useFollow(active);
	return (
		<div ref={ref} className="relative overflow-x-auto overscroll-x-contain">
			{children}
		</div>
	);
}

export function SceneTimeline({
	document,
	time,
	onSeek,
}: {
	document: SceneAnalysisDocument;
	time: number | null;
	onSeek: (seconds: number) => void;
}) {
	const { t } = useT();
	const [zoom, setZoom] = useState(1);
	const current =
		time === null
			? undefined
			: document.scenes.find(
					(s) => time >= s.startInSeconds && time < s.endInSeconds,
				);
	const shotIndex = current?.shots.findIndex(
		(s) => time !== null && time >= s.startInSeconds && time < s.endInSeconds,
	);
	const shotRef = useFollow(`${current?.id}:${shotIndex}`);
	return (
		<div className="space-y-4">
			<section
				aria-label={t("library.timeline")}
				className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
			>
				<SceneNavigator scenes={document.scenes} currentSceneId={current?.id}>
					{(scenes, offset) => (
						<SceneStrip
							active={current ? `${current.id}:${offset}` : undefined}
						>
							<div
								className="flex gap-1"
								style={{
									width: `${zoom * 100}%`,
									minWidth: `${scenes.length * 112}px`,
								}}
							>
								{scenes.map((scene, index) => {
									const score = scene.adOpportunityInformation?.score;
									const ad = score !== undefined && score > 0.5;
									const tension = scene.content?.dynamics?.tension;
									const style = tension ? tensionStyles[tension] : undefined;
									const active = current?.id === scene.id;
									return (
										<button
											key={scene.id}
											type="button"
											aria-current={active}
											data-ad-opportunity={ad}
											onClick={() => onSeek(scene.startInSeconds)}
											aria-label={`${clockTime(scene.startInSeconds)} · ${scene.title || scene.type} · ${t("library.adOpportunity")}: ${score ?? t("library.unreported")}`}
											title={`${scene.title}\n${scene.type} · ${clockTime(scene.startInSeconds)}–${clockTime(scene.endInSeconds)}\n${tension ?? t("library.unreported")} · ${scene.content?.dynamics?.pacing ?? ""}\n${scene.adOpportunityInformation?.reason ?? ""}`}
											className={`min-w-0 flex-1 overflow-hidden rounded border text-left focus-visible:outline-2 focus-visible:outline-emerald-400 ${active ? "border-emerald-400" : "border-zinc-800"}`}
										>
											<span
												className={`block h-16 p-1 text-[11px] ${sceneTypes[scene.type] ?? "bg-zinc-900"}`}
											>
												<span className="block font-mono text-zinc-400">
													{String(offset + index + 1).padStart(2, "0")}
												</span>
												<span className="line-clamp-2 break-words">
													{scene.title || scene.type}
												</span>
											</span>
											<span className="relative block h-16 bg-zinc-900/50">
												{style && (
													<span
														className={`absolute inset-x-0 bottom-0 ${style.color}`}
														style={{ height: `${style.height}%` }}
													/>
												)}
												<span
													className={`relative block p-1 font-mono text-[10px] ${ad ? "font-bold text-emerald-300" : "text-zinc-400"}`}
												>
													{score === undefined
														? t("library.unreported")
														: `Ad ${score}`}
												</span>
												{active && time !== null && (
													<span
														className="absolute inset-y-0 w-0.5 bg-white"
														style={{
															left: `${Math.min(100, Math.max(0, ((time - scene.startInSeconds) / (scene.endInSeconds - scene.startInSeconds)) * 100))}%`,
														}}
													/>
												)}
											</span>
										</button>
									);
								})}
							</div>
						</SceneStrip>
					)}
				</SceneNavigator>
				<div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
					<p>
						{t("library.dynamics")}: <span className="text-blue-300">LOW</span>{" "}
						· <span className="text-emerald-300">MODERATE</span> ·{" "}
						<span className="text-amber-300">HIGH</span> ·{" "}
						<span className="text-red-300">EXTREME</span>{" "}
						<InfoHint
							text={t("library.adThreshold")}
							labelFor={t("library.adOpportunity")}
						/>
					</p>
					<label className="flex items-center gap-2">
						{t("library.zoom")}
						<input
							className="w-24 accent-emerald-400"
							type="range"
							min="1"
							max="5"
							step="0.5"
							value={zoom}
							onChange={(e) => setZoom(Number(e.target.value))}
						/>
					</label>
				</div>
			</section>
			{current && current.shots.length > 0 && (
				<section className="space-y-2">
					<h3 className="text-sm font-medium">
						{t("library.shots")} · {current.shots.length}
					</h3>
					<div
						ref={shotRef}
						className="relative flex gap-2 overflow-x-auto overscroll-x-contain pb-2"
					>
						{current.shots.map((shot, i) => (
							<button
								key={`${shot.startInSeconds}-${i}`}
								type="button"
								aria-current={shotIndex === i}
								onClick={() => onSeek(shot.startInSeconds)}
								title={shot.detailedDescription}
								className={`w-40 shrink-0 rounded-md border p-2 text-left focus-visible:outline-2 focus-visible:outline-emerald-400 ${shotIndex === i ? "border-emerald-500 bg-emerald-950/30" : "border-zinc-800 bg-zinc-900"}`}
							>
								<span className="font-mono text-xs text-emerald-300">
									{clockTime(shot.startInSeconds)}
								</span>
								<span className="mt-1 line-clamp-2 text-xs text-zinc-300">
									{shot.detailedDescription || "—"}
								</span>
							</button>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
