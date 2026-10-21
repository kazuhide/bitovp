"use client";

import type {
	PerTitleCodec,
	PerTitleGoal,
	PerTitleProposal,
} from "@bitovp/core";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/context";
import { buildPlan, type WizardState } from "./build-plan";
import { PerTitleSimulator } from "./per-title-simulator";
import {
	applyPerTitleProposal,
	perTitleGoalFromWizard,
} from "./per-title-simulator-wizard";

type Change = { path: string; before: unknown; after: unknown };

function planChanges(before: unknown, after: unknown, path = ""): Change[] {
	if (JSON.stringify(before) === JSON.stringify(after)) return [];
	if (Array.isArray(before) && Array.isArray(after)) {
		return Array.from(
			{ length: Math.max(before.length, after.length) },
			(_, i) => planChanges(before[i], after[i], `${path}[${i}]`),
		).flat();
	}
	if (
		before !== null &&
		after !== null &&
		typeof before === "object" &&
		typeof after === "object" &&
		!Array.isArray(before) &&
		!Array.isArray(after)
	) {
		const a = before as Record<string, unknown>;
		const b = after as Record<string, unknown>;
		return [...new Set([...Object.keys(a), ...Object.keys(b)])]
			.sort()
			.flatMap((key) =>
				planChanges(a[key], b[key], path ? `${path}.${key}` : key),
			);
	}
	return [{ path, before, after }];
}

const copy = {
	en: {
		open: "Open simulator",
		title: "Review ladder changes",
		description:
			"Review changes to the encoding plan before applying them to this draft.",
		before: "Current",
		after: "Proposed",
		field: "Plan field",
		apply: "Apply to draft",
		back: "Back to simulator",
		unset: "Not set",
		stale:
			"The draft changed while the simulator was open. Close it and open it again to use the latest settings.",
		unsafe:
			"This proposal cannot be applied while preserving the current stream and output references. You can still inspect its API settings in the simulator.",
		invalid:
			"This proposal cannot be applied. Review its conditions in the simulator.",
		unsupported:
			"The current ladder contains settings that this simulator cannot safely replace. You can edit the ladder directly.",
		forced:
			"This proposal removes the existing upper-rendition addition settings. Its rendition count model does not use this addition.",
		empty: "The draft already uses these settings.",
	},
	ja: {
		open: "シミュレーターを開く",
		title: "ラダー設定の変更を確認",
		description:
			"エンコード設定の変更内容を確認して、編集中の設定へ反映します。",
		before: "現在",
		after: "提案",
		field: "設定項目",
		apply: "編集中の設定に反映",
		back: "シミュレーターに戻る",
		unset: "未指定",
		stale:
			"シミュレーターを開いた後に元の設定が変更されています。閉じてから開き直し、最新の設定で比較してください。",
		unsafe:
			"現在のストリームや出力先の関連付けを保ったまま、この提案を反映できません。シミュレーターでAPI設定を参照できます。",
		invalid:
			"この提案は反映できません。シミュレーターで条件を確認してください。",
		unsupported:
			"現在のラダーには、このシミュレーターで安全に置き換えられない設定が含まれています。ラダーの入力欄で編集できます。",
		forced:
			"この提案では、上位レンディションを追加する既存の設定を解除します。本数の比較は、この追加設定を使わない条件で行っています。",
		empty: "編集中の設定と同じ内容です。",
	},
};

type Session = {
	state: WizardState;
	fingerprint: string;
	goal: ReturnType<typeof perTitleGoalFromWizard>;
	goalsByCodec: Partial<Record<PerTitleCodec, PerTitleGoal>>;
};

export function PerTitleSimulatorLauncher({
	state,
	onPatch,
	hevcV2Available = false,
}: {
	state: WizardState;
	onPatch: (patch: Partial<WizardState>) => void;
	hevcV2Available?: boolean;
}) {
	const { locale } = useT();
	const text = copy[locale];
	const [session, setSession] = useState<Session | null>(null);
	const [review, setReview] = useState<{
		next: WizardState;
		changes: Change[];
		removesForced: boolean;
	} | null>(null);
	const [error, setError] = useState<string>();
	const stale = () => session?.fingerprint !== JSON.stringify(state);

	const open = () => {
		setError(undefined);
		try {
			const snapshot = structuredClone(state);
			const goal = perTitleGoalFromWizard(snapshot);
			const goalsByCodec: Session["goalsByCodec"] = { [goal.codec]: goal };
			const codecs: PerTitleCodec[] = [
				"H264",
				"H265",
				"VP9",
				"AV1",
				...(hevcV2Available ? (["H265V2"] as const) : []),
			];
			for (const codec of codecs) {
				if (codec === goal.codec) continue;
				try {
					goalsByCodec[codec] = perTitleGoalFromWizard(snapshot, codec);
				} catch {
					// An unsupported ladder remains available for direct editing.
				}
			}
			setSession({
				state: snapshot,
				fingerprint: JSON.stringify(state),
				goal,
				goalsByCodec,
			});
		} catch {
			setError(text.unsupported);
		}
	};
	const inspect = (proposal: PerTitleProposal) => {
		if (!session) return;
		setError(undefined);
		if (stale()) {
			setError(text.stale);
			return;
		}
		if (proposal.codec === "H265V2" && !hevcV2Available) {
			setError(text.unsupported);
			return;
		}
		try {
			const next = applyPerTitleProposal(
				session.state,
				proposal,
				proposal.codec,
			);
			const slot =
				proposal.codec === "H265V2"
					? "h265"
					: (proposal.codec.toLowerCase() as "h264" | "h265" | "vp9" | "av1");
			const oldGlobal = session.state.startOptions?.perTitle?.[slot];
			const newGlobal = next.startOptions?.perTitle?.[slot];
			const forcedKeys = [
				"forcedRenditionAboveHighestFixedRepresentation",
				"forcedRenditionAboveHighestFixedRepresentationFactor",
				"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
			] as const;
			setReview({
				next,
				changes: planChanges(buildPlan(session.state), buildPlan(next)),
				removesForced: forcedKeys.some(
					(key) =>
						oldGlobal?.[key] !== undefined && newGlobal?.[key] === undefined,
				),
			});
		} catch (caught) {
			const code =
				caught instanceof Error && "code" in caught ? caught.code : undefined;
			setError(
				code === "UNSAFE_RESHAPE"
					? text.unsafe
					: code === "UNSUPPORTED_STATE"
						? text.unsupported
						: text.invalid,
			);
		}
	};
	const confirm = () => {
		if (!review) return;
		if (stale()) {
			setError(text.stale);
			return;
		}
		onPatch(review.next);
		setReview(null);
		setSession(null);
		setError(undefined);
	};

	return (
		<>
			<Button variant="secondary" size="sm" onClick={open}>
				<SlidersHorizontal aria-hidden className="h-3.5 w-3.5" />
				{text.open}
			</Button>
			{error && !session ? (
				<p role="alert" className="mt-2 text-amber-300 text-xs">
					{error}
				</p>
			) : null}
			{session ? (
				<PerTitleSimulator
					open={!review}
					onOpenChange={(value) => {
						if (!value) {
							setSession(null);
							setError(undefined);
						}
					}}
					initialGoal={session.goal}
					goalsByCodec={session.goalsByCodec}
					onApply={inspect}
					applyError={review ? undefined : error}
				/>
			) : null}
			<Dialog
				open={review !== null}
				onOpenChange={(value) => {
					if (!value) {
						setReview(null);
						setError(undefined);
					}
				}}
				title={text.title}
				description={text.description}
				wide
			>
				{review ? (
					<div className="space-y-4">
						{review.removesForced ? (
							<p className="rounded-md border border-amber-900/50 bg-amber-950/20 p-3 text-amber-200 text-xs">
								{text.forced}
							</p>
						) : null}
						{review.changes.length === 0 ? (
							<p className="text-sm text-zinc-400">{text.empty}</p>
						) : (
							<div className="max-h-[50vh] overflow-auto rounded-md border border-zinc-800">
								<table className="w-full table-fixed text-left text-xs">
									<thead className="sticky top-0 bg-zinc-900">
										<tr>
											<th className="w-1/3 p-3">{text.field}</th>
											<th className="p-3">{text.before}</th>
											<th className="p-3">{text.after}</th>
										</tr>
									</thead>
									<tbody>
										{review.changes.map((change) => (
											<tr
												key={change.path}
												className="border-zinc-800 border-t align-top"
											>
												<th
													scope="row"
													className="break-all p-3 font-mono font-normal text-zinc-400"
												>
													{change.path}
												</th>
												<td className="p-3">
													<pre className="whitespace-pre-wrap break-all text-zinc-400">
														{change.before === undefined
															? text.unset
															: typeof change.before === "string"
																? change.before
																: JSON.stringify(change.before, null, 2)}
													</pre>
												</td>
												<td className="p-3">
													<pre className="whitespace-pre-wrap break-all text-zinc-200">
														{change.after === undefined
															? text.unset
															: typeof change.after === "string"
																? change.after
																: JSON.stringify(change.after, null, 2)}
													</pre>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						{error ? (
							<p role="alert" className="text-amber-300 text-xs">
								{error}
							</p>
						) : null}
						<div className="flex flex-wrap justify-end gap-2">
							<Button
								variant="secondary"
								onClick={() => {
									setReview(null);
									setError(undefined);
								}}
							>
								{text.back}
							</Button>
							<Button disabled={review.changes.length === 0} onClick={confirm}>
								{text.apply}
							</Button>
						</div>
					</div>
				) : null}
			</Dialog>
		</>
	);
}
