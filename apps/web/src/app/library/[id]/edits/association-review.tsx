"use client";
import { cfrTimeMapSchema, sceneAnalysisDocumentSchema } from "@bitovp/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useProductionCopy } from "./production-copy";

const inspectionSchema = z.object({
	association: z.string().max(64),
	media: z.object({
		id: z.uuid(),
		state: z.literal("READY"),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		url: z.string().nullable(),
		timeMap: cfrTimeMapSchema,
	}),
	analysis: z.object({ id: z.uuid(), document: sceneAnalysisDocumentSchema }),
});
const known = z.enum(["CAPTURED_INPUT", "FIXTURE_AUTHORED", "EDITOR_ATTESTED"]);
const confirmedSchema = z.object({
	confirmed: z.literal(true),
	bindingKind: known,
});
type Inspection = z.infer<typeof inspectionSchema>;

export function AssociationReview({
	mediaVersionId,
	analysisRevisionId,
	disabled,
	onVerified,
}: {
	mediaVersionId: string;
	analysisRevisionId: string;
	disabled: boolean;
	onVerified(verified: boolean): void;
}) {
	const c = useProductionCopy(),
		id = useId(),
		canMutate = useMutationAccess("library.edits.edit");
	const [inspection, setInspection] = useState<Inspection | null>(null),
		[loading, setLoading] = useState(true);
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[uncertain, setUncertain] = useState(false);
	const [checks, setChecks] = useState({
			time: false,
			geometry: false,
			content: false,
		}),
		[videoReady, setVideoReady] = useState(false),
		[videoError, setVideoError] = useState(false);
	const video = useRef<HTMLVideoElement>(null),
		submitting = useRef(false),
		requestKey = useRef<string | null>(null),
		mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const readController = useRef<AbortController | null>(null);
	const inspect = useCallback(() => {
		readController.current?.abort();
		const controller = new AbortController();
		readController.current = controller;
		onVerified(false);
		setLoading(true);
		setInspection(null);
		setError("");
		setVideoReady(false);
		setVideoError(false);
		setChecks({ time: false, geometry: false, content: false });
		const query = new URLSearchParams({ mediaVersionId, analysisRevisionId });
		void apiFetch<unknown>(`/api/library/analysis-associations?${query}`, {
			signal: controller.signal,
		})
			.then((value) => {
				const parsed = inspectionSchema.parse(value);
				if (
					parsed.media.id !== mediaVersionId ||
					parsed.analysis.id !== analysisRevisionId ||
					parsed.media.timeMap.mediaVersionId !== mediaVersionId ||
					!parsed.media.url ||
					!new RegExp(
						`^/api/library/media-versions/${mediaVersionId}/media(?:\\?|$)`,
					).test(parsed.media.url)
				)
					throw new Error("ASSOCIATION_RESPONSE_INVALID");
				if (!controller.signal.aborted) {
					setInspection(parsed);
					onVerified(known.safeParse(parsed.association).success);
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) setError(c.error);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
	}, [mediaVersionId, analysisRevisionId, onVerified, c.error]);
	useEffect(() => {
		inspect();
		return () => readController.current?.abort();
	}, [inspect]);
	async function confirm() {
		if (
			disabled ||
			!canMutate ||
			submitting.current ||
			!inspection ||
			!videoReady ||
			videoError ||
			!checks.time ||
			!checks.geometry ||
			!checks.content
		)
			return;
		submitting.current = true;
		setBusy(true);
		setError("");
		setUncertain(false);
		requestKey.current ??= crypto.randomUUID();
		try {
			const response = confirmedSchema.parse(
				await apiFetch<unknown>("/api/library/analysis-associations", {
					method: "POST",
					body: JSON.stringify({
						mediaVersionId,
						analysisRevisionId,
						requestKey: requestKey.current,
						confirmation: checks,
					}),
				}),
			);
			if (mounted.current) {
				setInspection({ ...inspection, association: response.bindingKind });
				onVerified(true);
			}
		} catch (failure) {
			const unknown = !(failure instanceof ApiError) || failure.status >= 500;
			if (!unknown) requestKey.current = null;
			if (mounted.current) {
				setError(c.error);
				setUncertain(unknown);
			}
		} finally {
			submitting.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	const verified =
		inspection && known.safeParse(inspection.association).success;
	return (
		<section
			aria-labelledby={`${id}-title`}
			className="space-y-3 border-zinc-800 border-t pt-4"
		>
			<h3 id={`${id}-title`} className="font-medium text-sm">
				{c.associationTitle}
			</h3>
			{loading && (
				<p role="status" className="text-sm text-zinc-400">
					{c.loadingAssociation}
				</p>
			)}
			{verified && (
				<div role="status" className="space-y-1 text-sm">
					<p className="text-emerald-400">{c.verified}</p>
					<p className="text-zinc-400">
						{inspection.association === "CAPTURED_INPUT"
							? c.captured
							: inspection.association === "FIXTURE_AUTHORED"
								? c.fixture
								: c.attested}
					</p>
				</div>
			)}
			{inspection && !verified && (
				<>
					<p className="text-amber-300 text-sm">{c.unverified}</p>
					<dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-400">
						<div>
							<dt>{c.resolution}</dt>
							<dd>
								{inspection.media.width}×{inspection.media.height}
							</dd>
						</div>
						<div>
							<dt>{c.originalStart}</dt>
							<dd>
								{(inspection.media.timeMap.sourceStartUs / 1_000_000).toFixed(
									3,
								)}
								s
							</dd>
						</div>
					</dl>
					<video
						ref={video}
						aria-label={c.video}
						className="max-h-80 w-full rounded border border-zinc-800 bg-black"
						controls
						muted
						playsInline
						preload="metadata"
						src={inspection.media.url ?? undefined}
						onLoadedMetadata={() => setVideoReady(true)}
						onError={() => {
							setVideoReady(false);
							setVideoError(true);
						}}
					/>
					{videoError && (
						<p role="alert" className="text-amber-300 text-sm">
							{c.videoError}
						</p>
					)}
					<div className="space-y-2">
						<h4 className="font-medium text-sm">{c.scenes}</h4>
						{!inspection.analysis.document.scenes.length && (
							<p className="text-sm text-zinc-400">{c.noScenes}</p>
						)}
						<ol className="max-h-64 space-y-2 overflow-y-auto text-sm">
							{inspection.analysis.document.scenes.slice(0, 20).map((scene) => (
								<li
									key={scene.id}
									className="rounded border border-zinc-800 p-3"
								>
									<Button
										size="sm"
										variant="ghost"
										disabled={!videoReady}
										onClick={() => {
											if (video.current)
												video.current.currentTime = Math.max(
													0,
													Math.min(
														scene.startInSeconds -
															inspection.media.timeMap.sourceStartUs /
																1_000_000,
														(inspection.media.timeMap.sourceEndUs -
															inspection.media.timeMap.sourceStartUs) /
															1_000_000,
													),
												);
										}}
									>
										{scene.startInSeconds.toFixed(2)}–
										{scene.endInSeconds.toFixed(2)}s
									</Button>
									<p className="break-words font-medium">{scene.title}</p>
									<p className="break-words text-zinc-400">{scene.summary}</p>
								</li>
							))}
						</ol>
						{inspection.analysis.document.scenes.length > 20 && (
							<p className="text-xs text-zinc-400">{c.moreScenes}</p>
						)}
					</div>
					<fieldset
						disabled={
							disabled || busy || !canMutate || !videoReady || videoError
						}
						className="space-y-2"
					>
						<legend className="mb-2 text-xs text-zinc-400">
							{c.associationHelp}
						</legend>
						{(["time", "geometry", "content"] as const).map((key) => (
							<label key={key} className="flex items-start gap-3 text-sm">
								<input
									className="mt-1 accent-emerald-600"
									type="checkbox"
									checked={checks[key]}
									onChange={(e) =>
										setChecks({ ...checks, [key]: e.target.checked })
									}
								/>
								<span>{c[key]}</span>
							</label>
						))}
					</fieldset>
					{canMutate && (
						<Button
							variant="secondary"
							disabled={
								disabled ||
								busy ||
								!canMutate ||
								!videoReady ||
								videoError ||
								!checks.time ||
								!checks.geometry ||
								!checks.content
							}
							onClick={() => {
								void confirm();
							}}
						>
							{busy ? c.confirming : c.confirm}
						</Button>
					)}
				</>
			)}
			{error && (
				<div role="alert" className="space-y-1 text-amber-300 text-sm">
					<p>{error}</p>
					{uncertain && <p>{c.unknown}</p>}
				</div>
			)}
			{(error || videoError) && (
				<Button
					variant="secondary"
					disabled={busy || loading}
					onClick={inspect}
				>
					{c.reload}
				</Button>
			)}
		</section>
	);
}
