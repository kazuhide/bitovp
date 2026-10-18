"use client";

import {
	MAX_RUN_CAP_MARGIN_MINUTES,
	SLATE_SUPPORTED_PROVIDERS,
	type SlateSource,
} from "@bitovp/core";
import Link from "next/link";
import { useState } from "react";
import { ProgramTimeline } from "@/app/live/program-timeline";
import { StoragePicker } from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

/**
 * The creation-time broadcast slot : the operator already knows
 * "the program runs X to Y, stream up at Z, slate until air" — this step is
 * that sentence as a form, with the timeline drawn live from the inputs.
 *
 * The inputs are the source of truth and the timeline is a rendering of
 * them; the datetime fields stay authoritative because a draggable timeline
 * in jsdom is untestable theater, while inputs + a live picture test cleanly
 * in both directions (type → picture moves; bad ordering → named error).
 *
 * Times are entered in the OPERATOR'S LOCAL ZONE (datetime-local) and
 * converted to ISO at submit — broadcast slots are planned in wall-clock
 * terms, and the one thing worse than timezone math is making the operator
 * do it.
 */

export type ScheduleDraft = {
	enabled: boolean;
	/** datetime-local values (operator's zone), "" = unset. */
	streamUpLocal: string;
	programStartLocal: string;
	programEndLocal: string;
	slateEnabled: boolean;
	slateSource: SlateSource | null;
	/**
	 * There is deliberately NO program-source field here. The
	 * file-fed chain (FEEDER_START → FEEDER_SWITCH) has its
	 * wizard entry back out on the owner's call: a pseudo-live feed is authored
	 * on `/live/feeders`, and this step schedules an EXTERNAL ingest plus its
	 * slate. The dangling comment that used to sit here still described the
	 * removed "external | file" choice, which is how a reader
	 * can conclude the wizard merely forgot the option. It did not.
	 * `schedule.feederPointer` says so on screen; this says so in the type.
	 */
};

export const EMPTY_SCHEDULE_DRAFT: ScheduleDraft = {
	enabled: false,
	streamUpLocal: "",
	programStartLocal: "",
	programEndLocal: "",
	slateEnabled: false,
	slateSource: null,
};

/** datetime-local → Date, null when unset/unparseable. */
export function localToDate(value: string): Date | null {
	if (!value) {
		return null;
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The auto-shutdown knobs the slot has to fit inside . Read from
 * the plan the wizard is about to SUBMIT (`evaluation.plan.start.autoShutdown`),
 * which is the form-built plan or the imported one — never the form state, so
 * the expert path is covered by the same check.
 */
export type ScheduleAutoShutdown = {
	bytesReadTimeoutSeconds?: number;
	streamTimeoutMinutes?: number;
	waitingForFirstConnectTimeoutMinutes?: number;
};

/**
 * The draft's validity + the request payload, in ONE place so the section,
 * the review summary and the submit body can never disagree. Mirrors the
 * server's ordering rules (core schema) — the server still owns the clock
 * checks (future/horizon), because a client clock proves nothing.
 *
 * The auto-shutdown rule is stated CLOCK-FREE for exactly that reason. The
 * server compares `programEndAt` against `provisionAt + streamTimeoutMinutes`;
 * this compares it against `streamUpAt + streamTimeoutMinutes`, which needs no
 * clock at all because both instants come from the form.
 *
 * Which of the two bounds is earlier depends on `provisionAt` vs `streamUpAt`,
 * and that ordering is EXPECTED but not guaranteed: the create route reads its
 * future-check clock (`new Date`, at `programScheduleWindowError`) and its
 * `provisionAtMs` separately, with awaited credential lookups in between, so a
 * slow request could in principle push provisioning past a stream-up that was
 * only seconds away. Both orderings are safe, in different directions:
 *
 *  - provisionAt ≤ streamUpAt (the normal case): the server's bound is the
 *    earlier one, so this refuses a strict SUBSET — some slots pass here and
 *    come back 422. The server is authoritative and says why.
 *  - provisionAt > streamUpAt (the slow-request case): this bound is the
 *    earlier one, so it refuses a SUPERSET — at worst a false-positive warning
 *    on a slot the server would have taken. It still never admits a slot the
 *    server refuses, which is the direction that matters.
 */
export function scheduleFromDraft(
	draft: ScheduleDraft,
	autoShutdown?: ScheduleAutoShutdown | null,
):
	| { ok: true; schedule: null }
	| {
			ok: true;
			schedule: {
				streamUpAt: string;
				programStartAt: string;
				programEndAt: string;
				slate?: { source: SlateSource };
			};
	  }
	| {
			ok: false;
			errorKey: string;
			params?: Record<string, string | number>;
	  } {
	if (!draft.enabled) {
		return { ok: true, schedule: null };
	}
	const up = localToDate(draft.streamUpLocal);
	const start = localToDate(draft.programStartLocal);
	const end = localToDate(draft.programEndLocal);
	if (!up || !start || !end) {
		return { ok: false, errorKey: "schedule.errIncomplete" };
	}
	if (up.getTime() > start.getTime()) {
		return { ok: false, errorKey: "schedule.errUpAfterStart" };
	}
	if (start.getTime() >= end.getTime()) {
		return { ok: false, errorKey: "schedule.errEndBeforeStart" };
	}
	if (draft.slateEnabled) {
		if (!draft.slateSource) {
			return { ok: false, errorKey: "schedule.errNoSlateSource" };
		}
		if (up.getTime() >= start.getTime()) {
			return { ok: false, errorKey: "schedule.errZeroSlateWindow" };
		}
	}
	const streamTimeoutMinutes = autoShutdown?.streamTimeoutMinutes;
	if (
		streamTimeoutMinutes !== undefined &&
		streamTimeoutMinutes > 0 &&
		// Milliseconds, not rounded minutes: rounding UP would refuse a
		// 5.2-minute slot under a 6-minute timeout, which the server accepts —
		// and a client refusal the server would not make is exactly the
		// over-reach this comparison is shaped to avoid.
		end.getTime() - up.getTime() >= streamTimeoutMinutes * 60_000
	) {
		return {
			ok: false,
			errorKey: "schedule.errStreamTimeoutShorterThanSlot",
			params: {
				minutes: streamTimeoutMinutes,
				slot: Math.round((end.getTime() - up.getTime()) / 60_000),
			},
		};
	}
	return {
		ok: true,
		schedule: {
			streamUpAt: up.toISOString(),
			programStartAt: start.toISOString(),
			programEndAt: end.toISOString(),
			...(draft.slateEnabled && draft.slateSource
				? { slate: { source: draft.slateSource } }
				: {}),
		},
	};
}

export function ScheduleSection({
	draft,
	onPatch,
	autoShutdown,
}: {
	draft: ScheduleDraft;
	onPatch: (partial: Partial<ScheduleDraft>) => void;
	autoShutdown?: ScheduleAutoShutdown | null;
}) {
	const { t } = useT();
	const [pickerOpen, setPickerOpen] = useState(false);
	const verdict = scheduleFromDraft(draft, autoShutdown);
	// #247: the knobs that can still end the run early but cannot be checked
	// against a slot — an idle input, or an input that never connects. Named
	// here rather than refused, because neither has a derivable instant.
	const conditionalKnobs = (
		["bytesReadTimeoutSeconds", "waitingForFirstConnectTimeoutMinutes"] as const
	).filter((knob) => (autoShutdown?.[knob] ?? 0) > 0);
	const up = localToDate(draft.streamUpLocal);
	const start = localToDate(draft.programStartLocal);
	const end = localToDate(draft.programEndLocal);
	const spanMinutes =
		up && end
			? Math.max(0, Math.ceil((end.getTime() - up.getTime()) / 60_000))
			: null;

	return (
		<div className="space-y-4">
			<label className="flex items-center gap-2 text-sm text-zinc-200">
				<input
					type="checkbox"
					checked={draft.enabled}
					onChange={(e) => onPatch({ enabled: e.target.checked })}
				/>
				{t("schedule.enableAtCreation")}
			</label>
			{/* ALWAYS visible, enabled or not — the one
			 * sentence that separates "planned input feed time" from "channel
			 * start". The detailed hints below explain billing and the
			    anchoring; this line is the thing an operator must not miss. */}
			<p data-schedule-note="provisions" className="text-xs text-zinc-400">
				{t("schedule.provisionsNote")}
			</p>
			{!draft.enabled ? (
				<p className="text-xs text-zinc-500">{t("schedule.disabledHint")}</p>
			) : (
				<div className="space-y-4">
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<Field
							label={t("schedule.streamUpAt")}
							htmlFor="sch-up"
							help={t("schedule.streamUpHint")}
						>
							<Input
								id="sch-up"
								type="datetime-local"
								value={draft.streamUpLocal}
								onChange={(e) => onPatch({ streamUpLocal: e.target.value })}
							/>
						</Field>
						<Field
							label={t("schedule.programStartAt")}
							htmlFor="sch-start"
							help={t("schedule.programStartHint")}
						>
							<Input
								id="sch-start"
								type="datetime-local"
								value={draft.programStartLocal}
								onChange={(e) => onPatch({ programStartLocal: e.target.value })}
							/>
						</Field>
						<Field
							label={t("schedule.programEndAt")}
							htmlFor="sch-end"
							help={t("schedule.programEndHint")}
						>
							<Input
								id="sch-end"
								type="datetime-local"
								value={draft.programEndLocal}
								onChange={(e) => onPatch({ programEndLocal: e.target.value })}
							/>
						</Field>
					</div>

					<ProgramTimeline
						streamUpAt={up}
						programStartAt={start}
						programEndAt={end}
						slate={draft.slateEnabled}
					/>

					{/* : the two facts the incident proved operators
					 * need BEFORE air, not after — the machinery ramps for a
					 * few minutes past stream-up, and a slate only renders on
					    a CONNECTED input. */}
					<p className="text-xs text-zinc-500">{t("schedule.rampHint")}</p>
					{draft.slateEnabled ? (
						<p className="text-amber-400/90 text-xs">
							{t("schedule.slateIngestHint")}
						</p>
					) : null}

					<label className="flex items-center gap-2 text-sm text-zinc-200">
						<input
							type="checkbox"
							checked={draft.slateEnabled}
							onChange={(e) => onPatch({ slateEnabled: e.target.checked })}
						/>
						{t("schedule.enableSlate")}
					</label>
					{draft.slateEnabled ? (
						<Field
							label={t("schedule.slateSource")}
							htmlFor="sch-slate-src"
							help={t("schedule.slateSourceHint")}
							trailing={
								<Button
									variant="secondary"
									size="sm"
									onClick={() => setPickerOpen(true)}
								>
									{t("feeder.browseStorage")}
								</Button>
							}
						>
							<Input
								id="sch-slate-src"
								readOnly
								value={
									draft.slateSource
										? `${draft.slateSource.bucket}/${draft.slateSource.key}`
										: ""
								}
								placeholder={t("schedule.slatePickPlaceholder")}
							/>
						</Field>
					) : null}

					{spanMinutes !== null ? (
						<p className="text-xs text-zinc-500">
							{/* The margin is the SERVER's, imported rather than retyped: a
							 * literal here goes stale the day `deriveProgramSchedule`
							 * changes it, and the preview would then quote a cap the
							 * channel never gets. `start-section.tsx` already reads the
						    constant this way. */}
							{t("schedule.capPreview", {
								minutes: spanMinutes + MAX_RUN_CAP_MARGIN_MINUTES,
							})}
						</p>
					) : null}
					{conditionalKnobs.length > 0 ? (
						<p className="text-xs text-zinc-500">
							{t("schedule.autoShutdownConditionalNote", {
								knobs: conditionalKnobs
									.map((knob) => `${knob}=${autoShutdown?.[knob]}`)
									.join(", "),
							})}
						</p>
					) : null}
					{!verdict.ok ? (
						<p role="alert" className="text-amber-400 text-sm">
							{t(verdict.errorKey as Parameters<typeof t>[0], verdict.params)}
						</p>
					) : null}

					<StoragePicker
						open={pickerOpen}
						mode="object"
						// Chain slates are DOWNLOADED BY THE FEEDER (7 drivers);
						// splice slates by insertable content (6). The picker
						// offers what the chosen path can actually read —
						// review-226 I2's swap, mirrored from the route.
						providers={[...SLATE_SUPPORTED_PROVIDERS]}
						onClose={() => setPickerOpen(false)}
						onSelect={({ credentialId, bucket, path }) => {
							onPatch({
								slateSource: { credentialId, bucket, key: path },
							});
							setPickerOpen(false);
						}}
					/>
				</div>
			)}

			{/* 's signpost, OUTSIDE the enabled/disabled branch on
			 * purpose: the operator this sentence is for came here looking for
			 * a file-fed program, and that operator has no reason to tick
			 * "schedule a broadcast slot" first — putting it inside the branch
			    would hide it from exactly the reader it addresses. */}
			<div className="space-y-1">
				<p className="text-xs text-zinc-500">{t("schedule.feederPointer")}</p>
				{/* Keep the link separate from the sentence rather than inserting a JSX space between Japanese characters. */}
				{/* A new tab : the wizard holds an unsaved draft
				    and navigating away discarded it. */}
				<Link
					href="/live/feeders"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-block text-emerald-400 text-xs hover:underline"
				>
					{t("nav.pseudoLiveFeeds")}
				</Link>
			</div>
		</div>
	);
}
