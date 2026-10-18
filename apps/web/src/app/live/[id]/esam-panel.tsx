"use client";

import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	ESAM_BINARY_MAX_LENGTH,
	esamMediaPointCreateSchema,
} from "@/lib/live-runtime/schemas";

type SignalRow = { offset: string; binary: string };

/**
 * ESAM (SCTE-250) media-point insertion — the out-of-band sibling of the
 * SCTE-35 cue form next to it. A cue says "start an ad break now for N
 * seconds"; a media point carries the caller's OWN pre-built SCTE-35 binary,
 * optionally matched to a wall-clock time and offset, which is what upstream
 * ad systems emit.
 *
 * RUNNING-gated (the route 409s otherwise) and it additionally requires the
 * encoding to have been STARTED with
 * `adInsertionSettings.enableEsamMediaPointInsertion` — spelled out in the copy
 * because Bitmovin's rejection is otherwise cryptic.
 *
 * Cross-reload history DOES exist: each insertion appends a DONE
 * `ESAM_MEDIA_POINT` entry to the channel step log, visible in the step
 * timeline with its matchTime and per-signal offsets . What this
 * panel still lacks is the dedicated "last media point inserted at" readout
 * that SCTE-35 cues get in channel-actions — the confirmation below is local
 * useState and vanishes on reload, because channel-detail does not pass this
 * panel the step entries. Ledgered, not forgotten.
 */
export function EsamPanel({
	channelId,
	status,
	bitmovinAccountId,
}: {
	channelId: string;
	status: LiveChannelStatus;
	bitmovinAccountId: string | null;
}) {
	const { t } = useT();
	const [matchTime, setMatchTime] = useState("");
	const [signals, setSignals] = useState<SignalRow[]>([
		{ offset: "", binary: "" },
	]);
	const [issues, setIssues] = useState<string[]>([]);
	const [insertedAt, setInsertedAt] = useState<string | null>(null);

	const insert = useMutation({
		mutationFn: (mediaPoint: unknown) =>
			apiFetch<{ insertedAt: string }>(
				`/api/live-channels/${channelId}/esam-media-point`,
				{
					method: "POST",
					body: JSON.stringify({ bitmovinAccountId, mediaPoint }),
				},
			),
		onMutate: () => setIssues([]),
		onSuccess: (data) => {
			setInsertedAt(data.insertedAt);
			setSignals([{ offset: "", binary: "" }]);
			setMatchTime("");
		},
	});

	if (status !== "RUNNING") {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("esam.needsRunning")}</p>
		);
	}
	if (!bitmovinAccountId) {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("prose.esamNoAccount")}</p>
		);
	}

	const submit = () => {
		// datetime-local is the operator's wall clock; guard the ECMAScript date
		// range before toISOString (which throws RangeError on overflow).
		let iso: string | undefined;
		if (matchTime !== "") {
			const date = new Date(matchTime);
			if (Number.isNaN(date.getTime())) {
				//  (UX-02e): was a hard-coded English sentence that
				// rendered inside the Japanese page.
				setIssues([t("esam.matchTimeInvalid")]);
				return;
			}
			iso = date.toISOString();
		}
		const parsed = esamMediaPointCreateSchema.safeParse({
			...(iso ? { matchTime: iso } : {}),
			signals: signals.map((signal) => ({
				...(signal.offset !== "" ? { offset: signal.offset } : {}),
				binary: signal.binary.trim(),
			})),
		});
		if (!parsed.success) {
			setIssues(
				parsed.error.issues.map((issue) =>
					issue.path.length > 0
						? `${issue.path.join(".")}: ${zodIssueMessage(issue, t)}`
						: zodIssueMessage(issue, t),
				),
			);
			return;
		}
		insert.mutate(parsed.data);
	};

	return (
		<details className="rounded-md border border-zinc-800 bg-zinc-900/40">
			<summary className="cursor-pointer select-none px-3 py-2 font-medium text-xs text-zinc-300 hover:text-zinc-100">
				{t("esam.title")}
				<span className="ml-1.5 inline-flex">
					<HelpOverlay labelFor={t("esam.title")}>
						{t("prose.esamIntro")}{" "}
						<code>{t("ui.adinsertionsettingsEnableesammediapointinser")}</code>{" "}
						{t("uiX.esamRejectsTail")}{" "}
						{t("ui.enableEsamMediaPointInsertionInThe")}
					</HelpOverlay>
				</span>
			</summary>
			<div className="space-y-3 border-zinc-800 border-t p-3">
				<Field
					label={t("esam.matchTime")}
					htmlFor="esam-match-time"
					help={t("ui.localTimeSentAsUtcBlankInserts")}
				>
					<Input
						id="esam-match-time"
						type="datetime-local"
						className="w-64"
						value={matchTime}
						onChange={(e) => setMatchTime(e.target.value)}
					/>
				</Field>

				<fieldset className="space-y-2">
					<legend className="font-medium text-xs text-zinc-300">
						{t("esam.signals")}
					</legend>
					{signals.map((signal, index) => (
						<div
							key={index}
							className="grid grid-cols-1 gap-2 rounded-md border border-zinc-800 p-2 sm:grid-cols-[10rem_1fr_auto]"
						>
							<Field label={t("esam.offset")} htmlFor={`esam-offset-${index}`}>
								<Input
									id={`esam-offset-${index}`}
									placeholder="PT10S"
									value={signal.offset}
									onChange={(e) =>
										setSignals((prev) =>
											prev.map((row, i) =>
												i === index ? { ...row, offset: e.target.value } : row,
											),
										)
									}
								/>
							</Field>
							<Field
								label={t("uiX.scte35BinaryMax", {
									max: ESAM_BINARY_MAX_LENGTH,
								})}
								htmlFor={`esam-binary-${index}`}
							>
								<Input
									id={`esam-binary-${index}`}
									autoComplete="off"
									className="font-mono text-xs"
									placeholder={t("ui.dagaaaaaaaaapWdwaa")}
									value={signal.binary}
									onChange={(e) =>
										setSignals((prev) =>
											prev.map((row, i) =>
												i === index ? { ...row, binary: e.target.value } : row,
											),
										)
									}
								/>
							</Field>
							{/* The GRID form of the #101 class. A grid cell stretches to the
							    row's height, so bottom-aligning inside it parks this button on
							    whatever the tallest Field's last line is — the hint or error
							    line, not the control line. Neither Field here carries a hint
							    today, which is exactly why it was invisible: the drift arrives
							    with the first validation error. Same slot as the flex rows. */}
							<FieldRowAction>
								<Button
									variant="ghost"
									size="icon"
									aria-label={t("uiX.removeSignalN", { n: index + 1 })}
									disabled={signals.length === 1}
									onClick={() =>
										setSignals((prev) => prev.filter((_, i) => i !== index))
									}
								>
									<Trash2 aria-hidden className="h-4 w-4" />
								</Button>
							</FieldRowAction>
						</div>
					))}
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							setSignals((prev) => [...prev, { offset: "", binary: "" }])
						}
					>
						<Plus aria-hidden className="h-4 w-4" /> {t("esam.addSignal")}
					</Button>
				</fieldset>

				{issues.length > 0 ? (
					<ul role="alert" className="space-y-0.5 text-red-400 text-xs">
						{issues.map((issue) => (
							<li key={issue}>{issue}</li>
						))}
					</ul>
				) : null}
				{insert.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{localizedCustomerError(t, insert.error, "esam.insertFailed")}
					</p>
				) : null}

				<Button size="sm" disabled={insert.isPending} onClick={submit}>
					{insert.isPending ? t("esam.inserting") : t("esam.insert")}
				</Button>

				{insertedAt ? (
					<p className="text-xs text-emerald-400">
						{t("uiX.lastMediaPointInsertedAt")}{" "}
						<span className="font-mono">
							{new Date(insertedAt).toLocaleTimeString()}
						</span>{" "}
						<span className="text-zinc-500">
							{t("ui.thisSessionOnlyMediaPointsAreNot")}
						</span>
					</p>
				) : null}
			</div>
		</details>
	);
}
