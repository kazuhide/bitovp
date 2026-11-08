"use client";
import type { HighlightCandidate } from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { EditingProjectView } from "@/lib/library-editing";
import { editingErrorMessage } from "../editing-errors";

export function CandidatePanel({
	project,
	disabled,
	remainingFrames,
	onFind,
	onAdd,
}: {
	project: EditingProjectView;
	disabled: boolean;
	remainingFrames: number;
	onFind: (
		query: string,
		sceneId: string,
		targetFrames: number,
	) => Promise<HighlightCandidate[]>;
	onAdd: (candidate: HighlightCandidate) => void;
}) {
	const { t } = useT();
	const [query, setQuery] = useState("");
	const [sceneId, setSceneId] = useState("");
	const [target, setTarget] = useState(900);
	const [items, setItems] = useState<HighlightCandidate[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function find() {
		if (disabled || busy) return;
		setBusy(true);
		setError("");
		try {
			setItems(await onFind(query, sceneId, target));
		} catch (failure) {
			setError(editingErrorMessage(failure, t));
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="min-w-0 space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
			<h2 className="font-semibold">{t("editing.candidates")}</h2>
			<p className="text-xs text-zinc-400">{t("editing.candidateHelp")}</p>
			{project.analysis ? (
				<>
					<Field label={t("editing.query")} htmlFor="editing-query">
						<Input
							id="editing-query"
							type="search"
							maxLength={200}
							value={query}
							disabled={disabled || busy}
							onChange={(e) => setQuery(e.target.value)}
						/>
					</Field>
					<SelectNative
						aria-label={t("editing.candidates")}
						value={sceneId}
						disabled={disabled || busy}
						onChange={(e) => setSceneId(e.target.value)}
					>
						<option value="">{t("editing.query")}</option>
						{project.analysis.document.scenes.map((scene) => (
							<option key={scene.id} value={scene.id}>
								{scene.startInSeconds.toFixed(1)}s · {scene.title || scene.type}
							</option>
						))}
					</SelectNative>
					<SelectNative
						aria-label={t("editing.duration", {
							seconds: target / 30,
							frames: target,
						})}
						value={target}
						disabled={disabled || busy}
						onChange={(e) => setTarget(Number(e.target.value))}
					>
						{[450, 900, 1800].map((frames) => (
							<option key={frames} value={frames}>
								{frames / 30}s
							</option>
						))}
					</SelectNative>
					<Button
						variant="secondary"
						disabled={disabled || busy || (!query.trim() && !sceneId)}
						onClick={() => void find()}
					>
						{t("editing.find")}
					</Button>
				</>
			) : (
				<p className="text-sm text-zinc-400">{t("editing.noAnalysis")}</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-400">
					{error}
				</p>
			)}
			{items?.length === 0 && (
				<p role="status" className="text-sm text-zinc-400">
					{t("editing.emptyCandidates")}
				</p>
			)}
			<ul className="space-y-3">
				{items?.map((candidate) => (
					<li
						key={`${candidate.sceneId}:${candidate.sourceInUs}`}
						className="space-y-2 border-zinc-800 border-t pt-3"
					>
						<p className="break-words text-sm">{candidate.title}</p>
						<p className="text-xs text-zinc-400">
							{(candidate.sourceInUs / 1_000_000).toFixed(2)}–
							{(candidate.sourceOutUs / 1_000_000).toFixed(2)}s
						</p>
						<p className="text-xs text-amber-300">
							{t("editing.analysisUnverified")}
						</p>
						<Button
							size="sm"
							variant="secondary"
							disabled={disabled || candidate.durationFrames > remainingFrames}
							onClick={() => onAdd(candidate)}
						>
							{t("editing.addCandidate")}
						</Button>
						{candidate.durationFrames > remainingFrames && (
							<p className="text-xs text-amber-300">{t("editing.budget")}</p>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
