"use client";

import {
	type CompositionPlan,
	canonicalEditingJson,
	compositionSourceSegmentSchema,
	mediaTaskCreateSchema,
	mediaTaskReceiptSchema,
	mediaTaskViewSchema,
} from "@bitovp/core";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { EditingMediaView } from "@/lib/library-editing";

type AudioRun = {
	mediaVersionId: string;
	sourceStartUs: number;
	durationUs: number;
	originalFromUs: number;
	originalToUs: number;
	outputFromFrame: number;
	outputToFrame: number;
};

/** The public TRANSCRIBE offset is prepared-media-relative, not source time. */
export function buildCompositionTranscriptionRuns(
	plan: CompositionPlan,
	media: readonly EditingMediaView[],
	contextUs = 3_000_000,
	merge = true,
): AudioRun[] {
	const groups: {
		mediaVersionId: string;
		lane: string;
		from: number;
		to: number;
		outputFrom: number;
		outputTo: number;
	}[] = [];
	for (const audio of [...plan.audio].sort(
		(a, b) => a.automation.timelineStartFrame - b.automation.timelineStartFrame,
	)) {
		const clip = plan.clips.find((item) => `clip:${item.clip.id}` === audio.id);
		const lane = audio.kind === "CLIP" ? clip?.trackId : audio.id;
		if (!lane) continue;
		const from = audio.sourceFromFrame;
		const to = from + audio.automation.durationFrames;
		const outputFrom = audio.automation.timelineStartFrame;
		const outputTo = outputFrom + audio.automation.durationFrames;
		const previous = groups.at(-1);
		if (
			merge &&
			previous &&
			previous.lane === lane &&
			previous.mediaVersionId === audio.mediaVersionId &&
			previous.to === from &&
			previous.outputTo === outputFrom
		) {
			previous.to = to;
			previous.outputTo = outputTo;
		} else
			groups.push({
				mediaVersionId: audio.mediaVersionId,
				lane,
				from,
				to,
				outputFrom,
				outputTo,
			});
	}
	return groups.flatMap((run) => {
		const source = plan.sources.find(
			(item) => item.mediaVersionId === run.mediaVersionId,
		);
		const prepared = media.find((item) => item.id === run.mediaVersionId);
		if (
			!source ||
			prepared?.state !== "READY" ||
			!prepared.timeMap ||
			canonicalEditingJson(source.timeMap) !==
				canonicalEditingJson(prepared.timeMap)
		)
			return [];
		const map = source.timeMap;
		const fromFrame = run.from - map.editingStartFrame;
		const toFrame = run.to - map.editingStartFrame;
		if (
			!Number.isSafeInteger(fromFrame) ||
			!Number.isSafeInteger(toFrame) ||
			fromFrame < 0 ||
			toFrame <= fromFrame
		)
			return [];
		// Round outwards to contain every selected audio sample; never infer word times.
		const fromUs = Number((BigInt(fromFrame) * 1_000_000n) / 30n);
		const toUs = Number((BigInt(toFrame) * 1_000_000n + 29n) / 30n);
		const available = Math.min(
			map.sourceEndUs - map.sourceStartUs,
			prepared.durationUs ?? 0,
		);
		if (toUs > available || toUs - fromUs > 180_000_000) return [];
		const room = Math.max(0, 180_000_000 - (toUs - fromUs));
		const before = Math.min(contextUs, fromUs, Math.floor(room / 2));
		const after = Math.min(contextUs, available - toUs, room - before);
		const sourceStartUs = fromUs - before;
		const durationUs = toUs + after - sourceStartUs;
		if (
			!Number.isSafeInteger(durationUs) ||
			durationUs < 1 ||
			sourceStartUs > 3_600_000_000
		)
			return [];
		return [
			{
				mediaVersionId: run.mediaVersionId,
				sourceStartUs,
				durationUs,
				originalFromUs: map.sourceStartUs + sourceStartUs,
				originalToUs: map.sourceStartUs + sourceStartUs + durationUs,
				outputFromFrame: run.outputFrom,
				outputToFrame: run.outputTo,
			},
		];
	});
}

const transcriptSchema = z.object({
	schemaVersion: z.literal(1),
	engine: z.literal("whisper.cpp"),
	sourceTimeDomain: z.literal("ORIGINAL_PRESENTATION_US"),
	language: z.string().regex(/^[a-z]{2,3}$/),
	segments: z.array(compositionSourceSegmentSchema).max(5000),
	warnings: z.array(z.string().max(128)).max(100),
});
type Transcript = z.infer<typeof transcriptSchema>;
const copy = {
	en: {
		title: "Check speech recognition",
		help: "Recognize source audio independently of the captions. Results use the original source clock and do not change your edit.",
		range: "Audio range",
		runs: "Continuous audio · up to 3 seconds of context on each side",
		clips: "Individual clips · no context",
		run: "Range",
		clip: "Clip",
		language: "Audio language",
		auto: "Detect automatically",
		ja: "Japanese",
		en: "English",
		start: "Recognize this audio",
		retry: "Confirm the same request",
		refresh: "Refresh recognition result",
		running: "Recognizing audio…",
		failed: "Could not read the recognition result.",
		unknown:
			"The request may have been accepted. Confirming will reuse the same request, without starting a duplicate.",
		readFailed: "The request was accepted. Refresh to read its result.",
		empty: "No speech was detected in this range.",
		unavailable: "No prepared source audio range is available.",
		readOnly: "Editing permission and an active organization are required.",
		results: "Recognition result",
		original: "Original source",
		output: "Timeline",
		words: "Estimated word times",
		noWords: "Word timing is unavailable for this segment.",
		warnings:
			"Recognition returned quality notes; compare the text with the audio.",
		cached: "Existing recognition result",
		task: "Task",
	},
	ja: {
		title: "音声認識結果を確認",
		help: "字幕を使わず、元映像の音声を独立に認識します。時刻は元映像のものです。編集内容や字幕は変更しません。",
		range: "認識する音声",
		runs: "連続区間（前後に最大3秒の余白）",
		clips: "各クリップ（余白なし）",
		run: "区間",
		clip: "クリップ",
		language: "音声の言語",
		auto: "自動判定",
		ja: "日本語",
		en: "英語",
		start: "この音声を認識",
		retry: "同じ依頼の受付を確認",
		refresh: "認識結果を再取得",
		running: "音声を認識しています…",
		failed: "音声認識の結果を取得できませんでした。",
		unknown:
			"依頼が受け付けられた可能性があります。同じ依頼で確認するため、重複して開始しません。",
		readFailed: "依頼は受け付けられています。結果を再取得してください。",
		empty: "この範囲では発話が検出されませんでした。",
		unavailable: "認識できる準備済みの元音声がありません。",
		readOnly: "編集権限と利用中の組織が必要です。",
		results: "音声認識結果",
		original: "元映像",
		output: "タイムライン",
		words: "推定した単語時刻",
		noWords: "この発話には単語単位の時刻がありません。",
		warnings:
			"認識品質に関する注記があります。音声と照らし合わせて確認できます。",
		cached: "既存の認識結果",
		task: "タスク",
	},
};
function time(us: number) {
	const ms = Math.floor(us / 1000);
	return `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
function wait(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, 1500);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
class InvalidRecognition extends Error {}
type Props = {
	projectId: string;
	plan: CompositionPlan;
	media: readonly EditingMediaView[];
	actorIdentity: string | null;
	disabled?: boolean;
};
type Option = AudioRun & { type: "run" | "clip"; ordinal: number };

export function CompositionTranscriptionControls({
	projectId,
	plan,
	media,
	actorIdentity,
	disabled,
}: Props) {
	const options: Option[] = [
		...buildCompositionTranscriptionRuns(plan, media).map((run, ordinal) => ({
			...run,
			type: "run" as const,
			ordinal,
		})),
		...buildCompositionTranscriptionRuns(plan, media, 0, false).map(
			(run, ordinal) => ({ ...run, type: "clip" as const, ordinal }),
		),
	];
	// Changing source clocks, audio selection, actor or organization discards the old session.
	return (
		<TranscriptionSession
			key={JSON.stringify([projectId, actorIdentity, options])}
			options={options}
			actorIdentity={actorIdentity}
			disabled={disabled}
		/>
	);
}

function TranscriptionSession({
	options,
	actorIdentity,
	disabled,
}: {
	options: Option[];
	actorIdentity: string | null;
	disabled?: boolean;
}) {
	const { locale } = useT();
	const c = copy[locale];
	const id = useId();
	const canMutate = useMutationAccess("library.edits.edit");
	const authorized = canMutate && Boolean(actorIdentity);
	const allowed = authorized && !disabled;
	const [selected, setSelected] = useState(0);
	const [language, setLanguage] = useState<"auto" | "ja" | "en">("auto");
	const [phase, setPhase] = useState<
		"IDLE" | "RUNNING" | "UNKNOWN" | "READ_FAILED" | "ERROR"
	>("IDLE");
	const [results, setResults] = useState<
		Record<string, { transcript: Transcript; taskId: string; cached: boolean }>
	>({});
	const active = useRef<AbortController | null>(null);
	const mounted = useRef(false);
	const current = useRef(allowed);
	current.current = allowed;
	const held = useRef<{ body: string; taskId?: string } | null>(null);
	const run = options[selected];
	const resultKey = `${selected}:${language}`;
	const result =
		authorized && phase === "IDLE" ? results[resultKey] : undefined;
	const busy = phase === "RUNNING";
	const actionLabel = busy
		? c.running
		: phase === "UNKNOWN"
			? c.retry
			: phase === "READ_FAILED"
				? c.refresh
				: c.start;
	const locked = busy || phase === "UNKNOWN" || phase === "READ_FAILED";
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			active.current?.abort();
		};
	}, []);
	useEffect(() => {
		if (!allowed) {
			active.current?.abort();
			active.current = null;
			// An interrupted POST may already have been accepted. Retain its exact
			// request until confirmed, even if saving temporarily disables this UI.
			setPhase(
				held.current?.taskId
					? "READ_FAILED"
					: held.current
						? "UNKNOWN"
						: "IDLE",
			);
			if (!authorized) setResults({});
		}
	}, [allowed, authorized]);
	async function recognize() {
		if (!current.current || !run || active.current) return;
		const controller = new AbortController();
		active.current = controller;
		const isCurrent = () =>
			mounted.current &&
			current.current &&
			!controller.signal.aborted &&
			active.current === controller;
		setPhase("RUNNING");
		let posted = false;
		let terminalResponse = false;
		try {
			if (!held.current) {
				const value = mediaTaskCreateSchema.parse({
					kind: "TRANSCRIBE",
					mediaVersionId: run.mediaVersionId,
					requestKey: crypto.randomUUID(),
					parameters: {
						sourceStartUs: run.sourceStartUs,
						durationUs: run.durationUs,
						language,
					},
				});
				held.current = { body: JSON.stringify(value) };
			}
			if (!held.current.taskId) {
				posted = true;
				const receipt = mediaTaskReceiptSchema.parse(
					await apiFetch<unknown>("/api/library/media-tasks", {
						method: "POST",
						body: held.current.body,
						signal: AbortSignal.any([
							controller.signal,
							AbortSignal.timeout(20_000),
						]),
					}),
				);
				if (!isCurrent()) return;
				held.current.taskId = receipt.taskId;
			}
			const taskId = held.current.taskId;
			while (isCurrent()) {
				const parsed = mediaTaskViewSchema.safeParse(
					await apiFetch<unknown>(`/api/library/media-tasks/${taskId}`, {
						signal: AbortSignal.any([
							controller.signal,
							AbortSignal.timeout(20_000),
						]),
					}),
				);
				if (!isCurrent()) return;
				if (
					!parsed.success ||
					parsed.data.taskId !== taskId ||
					parsed.data.kind !== "TRANSCRIBE" ||
					parsed.data.mediaVersionId !== run.mediaVersionId
				)
					throw new InvalidRecognition();
				const task = parsed.data;
				terminalResponse =
					task.state === "SUCCEEDED" ||
					task.state === "ERROR" ||
					task.state === "CANCELED";
				if (task.state === "SUCCEEDED") {
					const checked = transcriptSchema.safeParse(task.result);
					if (
						!checked.success ||
						checked.data.segments.some(
							(segment) =>
								segment.startUs < run.originalFromUs ||
								segment.endUs > run.originalToUs,
						)
					)
						throw new InvalidRecognition();
					setResults((previous) => ({
						...previous,
						[resultKey]: {
							transcript: checked.data,
							taskId,
							cached: task.cached,
						},
					}));
					held.current = null;
					setPhase("IDLE");
					return;
				}
				if (task.state === "ERROR" || task.state === "CANCELED")
					throw new InvalidRecognition();
				await wait(controller.signal);
			}
		} catch (failure) {
			if (!isCurrent()) return;
			// An accepted task remains owned until a matching, validated terminal
			// response confirms it finished. HTTP/transport/identity failures only
			// retry GET; they must never create a second recognition request.
			if (held.current?.taskId && !terminalResponse) setPhase("READ_FAILED");
			else if (
				terminalResponse ||
				(failure instanceof ApiError && failure.status < 500)
			) {
				held.current = null;
				setPhase("ERROR");
			} else if (posted) setPhase("UNKNOWN");
			else {
				held.current = null;
				setPhase("ERROR");
			}
		} finally {
			if (active.current === controller) active.current = null;
		}
	}
	return (
		<details className="min-w-0 rounded-lg border border-zinc-800 p-3">
			<summary className="cursor-pointer text-sm text-zinc-300">
				{c.title}
			</summary>
			<div className="mt-3 space-y-3 text-sm">
				<p className="max-w-prose text-zinc-400">{c.help}</p>
				{!allowed && <p className="text-zinc-400">{c.readOnly}</p>}
				{!run ? (
					<p className="text-zinc-400">{c.unavailable}</p>
				) : (
					<>
						<label className="block space-y-1" htmlFor={`${id}-range`}>
							<span>{c.range}</span>
							<select
								id={`${id}-range`}
								className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 p-2"
								value={selected}
								disabled={!allowed || locked}
								onChange={(event) => {
									setSelected(Number(event.target.value));
									setPhase("IDLE");
								}}
							>
								{(["run", "clip"] as const).map((type) => (
									<optgroup
										key={type}
										label={type === "run" ? c.runs : c.clips}
									>
										{options.map(
											(option, index) =>
												option.type === type && (
													<option key={index} value={index}>
														{type === "run" ? c.run : c.clip}{" "}
														{option.ordinal + 1} · {time(option.originalFromUs)}
														–{time(option.originalToUs)}
													</option>
												),
										)}
									</optgroup>
								))}
							</select>
						</label>
						<p className="text-xs text-zinc-400">
							{c.original}: {time(run.originalFromUs)}–{time(run.originalToUs)}{" "}
							· {c.output}: {time((run.outputFromFrame * 1_000_000) / 30)}–
							{time((run.outputToFrame * 1_000_000) / 30)}
						</p>
						<div className="flex flex-wrap items-end gap-3">
							<label className="space-y-1" htmlFor={`${id}-language`}>
								<span className="block">{c.language}</span>
								<select
									id={`${id}-language`}
									className="rounded border border-zinc-700 bg-zinc-950 p-2"
									value={language}
									disabled={!allowed || locked}
									onChange={(event) => {
										setLanguage(event.target.value as typeof language);
										setPhase("IDLE");
									}}
								>
									<option value="auto">{c.auto}</option>
									<option value="ja">{c.ja}</option>
									<option value="en">{c.en}</option>
								</select>
							</label>
							{canMutate ? (
								<Button
									type="button"
									disabled={!allowed || busy}
									onClick={() => void recognize()}
								>
									{actionLabel}
								</Button>
							) : (
								<Button type="button" disabled>
									{actionLabel}
								</Button>
							)}
						</div>
					</>
				)}
				{busy && (
					<p role="status" className="text-zinc-400">
						{c.running}
					</p>
				)}
				{phase === "ERROR" && (
					<p role="alert" className="text-amber-300">
						{c.failed}
					</p>
				)}
				{phase === "UNKNOWN" && (
					<p role="status" className="text-zinc-400">
						{c.unknown}
					</p>
				)}
				{phase === "READ_FAILED" && (
					<p role="status" className="text-zinc-400">
						{c.readFailed}
					</p>
				)}
				{result && (
					<section
						aria-label={c.results}
						className="space-y-3 border-t border-zinc-800 pt-3"
					>
						<p className="break-all text-xs text-zinc-400">
							{result.cached ? c.cached : c.results} ·{" "}
							{result.transcript.language} · {c.task}: {result.taskId}
						</p>
						{result.transcript.warnings.length > 0 && (
							<p className="text-zinc-400">{c.warnings}</p>
						)}
						{result.transcript.segments.length === 0 && <p>{c.empty}</p>}
						{result.transcript.segments.map((segment, index) => (
							<div key={index} className="space-y-1">
								<p className="font-mono text-xs text-zinc-400">
									{time(segment.startUs)}–{time(segment.endUs)}
								</p>
								<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
									{segment.text}
								</p>
								{segment.words?.length ? (
									<details>
										<summary className="cursor-pointer text-xs text-zinc-400">
											{c.words}
										</summary>
										<ul className="mt-1 space-y-1 text-xs text-zinc-300">
											{segment.words.map((word, wordIndex) => (
												<li key={wordIndex}>
													<span className="font-mono">
														{time(word.startUs)}–{time(word.endUs)}
													</span>{" "}
													{word.text}
												</li>
											))}
										</ul>
									</details>
								) : (
									<p className="text-xs text-zinc-500">{c.noWords}</p>
								)}
							</div>
						))}
					</section>
				)}
			</div>
		</details>
	);
}
