"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	applySelectedPerTitleAdvice,
	hasAutomaticPerTitleSettings,
	type PerTitleAdvice,
	type PerTitleAdviceEdit,
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
	perTitleAdvice,
	perTitleAdviceFieldKey,
	samePerTitleAdviceInput,
} from "./per-title-simulator-advice";
import {
	isPerTitleBitrateKey as bitrateKey,
	PerTitleAdviceChanges,
	perTitleAdviceValueText as valueText,
} from "./per-title-simulator-advice-changes";
import { perTitleSettingLabel } from "./per-title-simulator-control-copy";
import {
	getPerTitleGoalSetting,
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";

function singleEdit(
	before: PerTitleGoal,
	after: PerTitleGoal,
): PerTitleAdviceEdit | undefined {
	if (before.codec !== after.codec || before.strategy !== after.strategy)
		return;
	const edits: PerTitleAdviceEdit[] = perTitleGlobalFields(after.codec)
		.filter(
			({ key }) =>
				!Object.is(
					getPerTitleGoalSetting(before, "global", key),
					getPerTitleGoalSetting(after, "global", key),
				),
		)
		.map(({ key }) => ({ scope: "global", key }));
	for (const row of [
		...(after.rows ?? []),
		...(after.automaticTemplates ?? []),
	]) {
		for (const { key } of perTitleStreamFields(after.codec)) {
			if (
				!Object.is(
					getPerTitleGoalSetting(before, "stream", key, row.id),
					getPerTitleGoalSetting(after, "stream", key, row.id),
				)
			)
				edits.push({ scope: "stream", key, rowId: row.id });
		}
	}
	if (
		before.countPolicy.kind !== after.countPolicy.kind ||
		(before.countPolicy.kind !== "unrestricted" &&
			after.countPolicy.kind !== "unrestricted" &&
			before.countPolicy.count !== after.countPolicy.count)
	)
		edits.push({ scope: "count", key: "countPolicy" });
	return edits.length === 1 ? edits[0] : undefined;
}

function AdviceOption({
	advice,
	goal,
	onAdopt,
	onKeep,
	onApplySelected,
	locale,
}: {
	advice: PerTitleAdvice;
	goal: PerTitleGoal;
	onAdopt: (advice: PerTitleAdvice) => void;
	onKeep: (fields: PerTitleAdviceField[]) => void;
	onApplySelected: (
		advice: PerTitleAdvice,
		fields: PerTitleAdviceField[],
	) => void;
	locale: Locale;
}) {
	const ja = locale === "ja";
	const reason = {
		"joint-range": ja
			? "全体の下限と段構成を保ち、各段の範囲・複雑度境界・間隔・追加倍率をまとめて調整する案です。"
			: "Keep the overall minimum and template structure, and adjust rendition ranges, complexity boundaries, steps and the additional-rendition factor together.",
		"upper-boundary": ja
			? "全体上限と揃えていた複雑度の上側境界も、新しい上限に合わせる案です。各段のビットレート範囲は維持します。"
			: "Align the previously coupled upper complexity boundaries with the new overall maximum. Keep each rendition's bitrate range.",
		"lower-boundary": ja
			? "最高固定段の最小ビットレートと間隔の下限から、従来と同じ関係を保つ複雑度の下側境界を求めます。"
			: "Keep the previous lower-boundary relationship to the highest fixed rendition's minimum and the minimum bitrate step.",
		"global-range": ja
			? "変更した段の範囲が収まるように、全体の範囲を広げる案です。"
			: "Expand the overall range to contain the rendition range you changed.",
		"row-range": ja
			? "変更した全体の範囲に収まるように、はみ出した段の端だけを合わせる案です。"
			: "Keep your overall limits and bring only the outlying rendition endpoints inside them.",
		spacing: ja
			? "変更した値と各段の範囲を保って、ビットレート間隔を調整する案です。"
			: "Keep the value you changed and the rendition ranges, and adjust the bitrate steps.",
	}[advice.reason];
	const digits =
		advice.reason === "joint-range" ? advice.facts.roundingDigits : undefined;
	const rounded = digits === 2 || digits === 3 || digits === 4;
	const complexity = advice.proposal.api.streams.flatMap((row) =>
		row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
		row.perTitleSettings?.bitrateSelectionMode === "COMPLEXITY_RANGE"
			? [row.perTitleSettings]
			: [],
	);
	const high = complexity[0]?.highComplexityBoundaryForMaxBitrate;
	const commonHigh =
		complexity.length >= 2 &&
		typeof high === "number" &&
		Number.isSafeInteger(high) &&
		high > 0 &&
		complexity.every((row) => row.highComplexityBoundaryForMaxBitrate === high);
	return (
		<div className="space-y-3">
			<p className="text-xs text-zinc-300">{reason}</p>
			{rounded || digits === 0 ? (
				<p className="text-xs text-zinc-400">
					{rounded
						? ja
							? "変更可能な値を丸めて再確認済み。"
							: "Changeable values rounded and rechecked."
						: ja
							? "丸めない値で再確認済み。"
							: "Unrounded values rechecked."}
				</p>
			) : null}
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale={locale}
				onKeep={onKeep}
				onApplySelected={onApplySelected}
			/>
			<details className="space-y-2 text-xs text-zinc-400">
				<summary className="cursor-pointer">
					{ja ? "根拠と確認範囲" : "Reasoning and scope"}
				</summary>
				{advice.reason === "lower-boundary" ? (
					<p>
						{ja ? "下側境界" : "Lower boundary"} = trunc(
						{new Intl.NumberFormat(locale).format(
							advice.facts.highestFixedMinimum ?? Number.NaN,
						)}{" "}
						× {advice.facts.minimumStep}) ={" "}
						{new Intl.NumberFormat(locale).format(
							advice.facts.lower ?? Number.NaN,
						)}{" "}
						bps
					</p>
				) : null}
				{rounded ? (
					<p>
						{ja
							? `変更可能なビットレートは有効数字${digits}桁、間隔・追加倍率は小数${digits}桁で丸め、再確認します。維持する値は変更しません。`
							: `Changeable bitrates use ${digits} significant digits; steps and the additional factor use ${digits} decimal places, followed by rechecking. Kept values are unchanged.`}
					</p>
				) : digits === 0 ? (
					<p>
						{ja
							? "検証済みの丸めない値を使います。維持する値は変更しません。"
							: "Checked unrounded values are used. Kept values are unchanged."}
					</p>
				) : null}
				{advice.reason === "joint-range" && complexity.length > 0 ? (
					<>
						<p>
							{commonHigh
								? `${ja ? "共通H" : "Common H"}: ${valueText(high, "maxBitrate", locale)} kbps. `
								: ja
									? "Hは各段で設定します。"
									: "H is set per rendition. "}
							{ja
								? "Hは上側目標が各段それぞれの最大値に達する解析値で、共通Hでも各段のビットレートが同じになる意味ではありません。"
								: "H is the analysis threshold where the upper target reaches each rendition's own maximum; a common H does not mean equal bitrates."}
						</p>
						<p>
							{ja
								? "対象の段では共通Hの候補を確認し、独自・維持するHは保持します。行別のHを使う場合も、共通Hが不可能と証明したわけではありません。"
								: "Eligible rows try a common H; custom or kept H values are retained. Per-row H does not prove that a common H is impossible."}
						</p>
					</>
				) : null}
				{advice.reason === "joint-range" ? (
					<p>
						{ja
							? "全体の下限と維持する各段の端点を支点に、ほかの範囲を調整します。間隔・追加倍率と独立した複雑度境界を、丸め後の配置余地・接続・上限で再確認します。実際の出力本数は確定しません。"
							: "The overall minimum and kept rendition endpoints anchor the other ranges. Bitrate steps, the additional factor and independent complexity boundaries are rechecked against rounded placement room, connections and the cap. These checks do not establish output count."}
					</p>
				) : null}
				<p>
					{advice.proof === "model-count"
						? ja
							? "本数条件をこの計算モデルで確認しています。実際の出力本数・解像度・画質の確認には素材解析が必要です。"
							: "Count conditions are checked in this model. Actual output count, resolutions and quality still require content analysis."
						: ja
							? "変更後の設定を再計算した案です。自動生成を含む実際の本数や画質は、この計算では確定しません。"
							: "The edited settings are recalculated. This check does not establish the actual generated count or quality."}
				</p>
			</details>
			<Button
				data-advisor-adopt
				variant="secondary"
				size="sm"
				onClick={() => onAdopt(advice)}
			>
				{ja ? "この調整を採用" : "Use this adjustment"}
			</Button>
		</div>
	);
}

const EMPTY_FIELDS: readonly PerTitleAdviceField[] = [];
const protectionKey = (fields: readonly PerTitleAdviceField[]) =>
	JSON.stringify(fields.map(perTitleAdviceFieldKey).sort());

/** Keep continuous edits and retained fields scoped to the loaded simulator session. */
export function PerTitleAdvisor({
	goal,
	session,
	onAdopt,
}: {
	goal: PerTitleGoal;
	session: PerTitleGoal;
	onAdopt: (
		advice: PerTitleAdvice,
		options?: PerTitleAdviceOptions,
		selected?: readonly PerTitleAdviceField[],
	) => void;
}) {
	const { locale } = useT();
	const ja = locale === "ja";
	const id = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const pendingFocus = useRef<string | null>(null);
	const previous = useRef({ goal, session });
	const active = useRef<{
		before: PerTitleGoal;
		edit: PerTitleAdviceEdit;
		appliedFields: readonly PerTitleAdviceField[];
	} | null>(null);
	const pendingApplication = useRef<{
		goal: PerTitleGoal;
		active: NonNullable<typeof active.current>;
		fields: readonly PerTitleAdviceField[];
		complete: boolean;
	} | null>(null);
	const [protection, setProtection] = useState<{
		session: PerTitleGoal;
		codec: PerTitleGoal["codec"];
		fields: readonly PerTitleAdviceField[];
	}>({ session, codec: goal.codec, fields: [] });
	const liveProtection = useRef(protection);
	const fields =
		protection.session === session && protection.codec === goal.codec
			? protection.fields
			: EMPTY_FIELDS;
	const options = useMemo<PerTitleAdviceOptions>(
		() => ({ protectedFields: fields }),
		[fields],
	);
	const key = protectionKey(fields);
	const [snapshot, setSnapshot] = useState<{
		goal: PerTitleGoal;
		session: PerTitleGoal;
		key: string;
		items: PerTitleAdvice[];
	} | null>(null);
	useEffect(() => {
		const prior = previous.current;
		previous.current = { goal, session };
		if (prior.session !== session || prior.goal.codec !== goal.codec) {
			active.current = null;
			pendingApplication.current = null;
			pendingFocus.current = null;
			setSnapshot(null);
			liveProtection.current = { session, codec: goal.codec, fields: [] };
			setProtection(liveProtection.current);
			return;
		}
		const rowIds = new Set(
			[...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])].map(
				(row) => row.id,
			),
		);
		const retained = fields.filter(
			(field) => field.scope === "global" || rowIds.has(field.rowId ?? ""),
		);
		if (retained.length !== fields.length) {
			active.current = null;
			pendingApplication.current = null;
			pendingFocus.current = null;
			setSnapshot(null);
			liveProtection.current = { session, codec: goal.codec, fields: retained };
			setProtection(liveProtection.current);
			return;
		}
		if (prior.goal !== goal && pendingApplication.current) {
			const pending = pendingApplication.current;
			pendingApplication.current = null;
			if (samePerTitleAdviceInput(goal, pending.goal)) {
				active.current = pending.complete ? null : pending.active;
				if (pending.complete) setSnapshot(null);
				liveProtection.current = {
					session,
					codec: goal.codec,
					fields: pending.fields,
				};
				setProtection(liveProtection.current);
				pendingFocus.current = "adopt";
				return;
			}
		}
		if (prior.goal !== goal) {
			pendingFocus.current = null;
			const edit = singleEdit(prior.goal, goal);
			if (!edit) {
				active.current = null;
				setSnapshot(
					hasAutomaticPerTitleSettings(goal)
						? { goal, session, key, items: [] }
						: null,
				);
				return;
			}
			if (
				!active.current ||
				active.current.edit.scope !== edit.scope ||
				active.current.edit.key !== edit.key ||
				active.current.edit.rowId !== edit.rowId
			)
				active.current = { before: prior.goal, edit, appliedFields: [] };
		}
		if (active.current)
			setSnapshot({
				goal,
				session,
				key,
				items: perTitleAdvice(
					active.current.before,
					goal,
					active.current.edit,
					{ ...options, appliedFields: active.current.appliedFields },
				),
			});
	}, [goal, session, key, options, fields]);
	const matches =
		snapshot?.goal === goal &&
		snapshot.session === session &&
		snapshot.key === key;
	const items = matches ? snapshot.items : [];
	const first = items[0];
	useEffect(() => {
		const request = pendingFocus.current;
		if (request === null) return;
		if (request === "adopt" && active.current && !matches) return;
		const releases = [
			...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
				"button[data-maintained-field]",
			) ?? []),
		];
		const target =
			request === "adopt"
				? ((first
						? rootRef.current?.querySelector<HTMLButtonElement>(
								"button[data-advisor-adopt]",
							)
						: null) ?? releases[0])
				: fields.some((field) => perTitleAdviceFieldKey(field) === request)
					? releases.find(
							(button) => button.dataset.maintainedField === request,
						)
					: undefined;
		if (target) {
			pendingFocus.current = null;
			target.focus();
		} else if (matches) pendingFocus.current = null;
	}, [fields, first, matches]);
	const updateProtection = (next: readonly PerTitleAdviceField[]) => {
		liveProtection.current = { session, codec: goal.codec, fields: next };
		setProtection(liveProtection.current);
	};
	const keep = (added: PerTitleAdviceField[]) => {
		const current =
			liveProtection.current.session === session &&
			liveProtection.current.codec === goal.codec
				? liveProtection.current.fields
				: EMPTY_FIELDS;
		const unique = new Map(
			current.map((field) => [perTitleAdviceFieldKey(field), field]),
		);
		for (const field of added) unique.set(perTitleAdviceFieldKey(field), field);
		pendingFocus.current = added[0] ? perTitleAdviceFieldKey(added[0]) : null;
		updateProtection([...unique.values()]);
	};
	const release = (field: PerTitleAdviceField) => {
		const current =
			liveProtection.current.session === session &&
			liveProtection.current.codec === goal.codec
				? liveProtection.current.fields
				: EMPTY_FIELDS;
		const remaining = current.filter(
			(item) => perTitleAdviceFieldKey(item) !== perTitleAdviceFieldKey(field),
		);
		pendingFocus.current =
			active.current || remaining.length > 0 ? "adopt" : null;
		updateProtection(remaining);
	};
	const adopt = (advice: PerTitleAdvice) => {
		const live = liveProtection.current;
		if (
			!matches ||
			!snapshot.items.includes(advice) ||
			live.session !== session ||
			live.codec !== goal.codec ||
			protectionKey(live.fields) !== snapshot.key
		)
			return;
		active.current = null;
		pendingApplication.current = null;
		setSnapshot(null);
		onAdopt(advice, {
			protectedFields: live.fields.map((field) => ({ ...field })),
		});
	};
	const applySelected = (
		advice: PerTitleAdvice,
		selected: PerTitleAdviceField[],
	) => {
		const live = liveProtection.current;
		if (
			!matches ||
			!active.current ||
			!snapshot.items.includes(advice) ||
			live.session !== session ||
			live.codec !== goal.codec ||
			protectionKey(live.fields) !== snapshot.key
		)
			return;
		const options = {
			protectedFields: live.fields.map((field) => ({ ...field })),
		};
		const next = applySelectedPerTitleAdvice(goal, advice, selected, options);
		if (!next) return;
		const union = (
			a: readonly PerTitleAdviceField[],
			b: readonly PerTitleAdviceField[],
		) => [
			...new Map(
				[...a, ...b].map((field) => [perTitleAdviceFieldKey(field), field]),
			).values(),
		];
		pendingApplication.current = {
			goal: next,
			active: {
				...active.current,
				appliedFields: union(active.current.appliedFields, selected),
			},
			fields: union(live.fields, selected),
			complete: advice.changes.every((change) =>
				selected.some(
					(field) =>
						perTitleAdviceFieldKey(field) === perTitleAdviceFieldKey(change),
				),
			),
		};
		onAdopt(advice, options, selected);
	};
	const automatic = matches && hasAutomaticPerTitleSettings(goal);
	const unavailable = matches && fields.length > 0 && !first;
	if (!first && !fields.length && !automatic) return null;
	const allRows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	return (
		<div ref={rootRef} className="space-y-3">
			{fields.length > 0 ? (
				<section
					aria-label={ja ? "維持する値" : "Maintained values"}
					className="space-y-2 rounded-md border border-zinc-700 p-3 text-xs"
				>
					<h3 className="font-medium text-zinc-200">
						{ja ? "維持する値" : "Maintained values"}
					</h3>
					<ul className="space-y-2">
						{fields.map((field) => {
							const label = perTitleSettingLabel(field.key, locale);
							const row =
								field.scope === "stream"
									? allRows.findIndex((item) => item.id === field.rowId) + 1
									: undefined;
							const name = `${label}${row === undefined ? "" : `, ${ja ? "段" : "rendition"} ${row || "?"}`}`;
							return (
								<li
									key={perTitleAdviceFieldKey(field)}
									className="flex min-w-0 flex-wrap items-center justify-between gap-2"
								>
									<span className="min-w-0 break-words text-zinc-300">
										{name}:{" "}
										<span className="tabular-nums">
											{valueText(
												getPerTitleGoalSetting(
													goal,
													field.scope,
													field.key,
													field.rowId,
												),
												field.key,
												locale,
											)}
											{bitrateKey(field.key) ? " kbps" : ""}
										</span>
									</span>
									<Button
										variant="secondary"
										size="sm"
										data-maintained-field={perTitleAdviceFieldKey(field)}
										aria-label={`${ja ? "解除" : "Release"}: ${name}`}
										onClick={() => release(field)}
									>
										{ja ? "解除" : "Release"}
									</Button>
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
			{automatic ? (
				<p role="status" className="text-xs text-zinc-400">
					{ja
						? "自動調整が有効です。値を保持して調整案を確認する場合は、各項目を固定にしてください。"
						: "Automatic adjustment is enabled. Set the fields to Fixed to retain their values and review dependent adjustments."}
				</p>
			) : unavailable ? (
				<p role="status" className="text-xs text-zinc-400">
					{ja
						? "維持した値で確認できる調整案はありません。"
						: "No checked adjustment is available for these maintained values."}
				</p>
			) : null}
			{first ? (
				<section
					aria-labelledby={id}
					className="space-y-3 rounded-md border border-zinc-700 p-3"
				>
					<h3 id={id} className="font-medium text-sm text-zinc-200">
						{ja ? "調整案" : "Suggested adjustment"}
					</h3>
					<AdviceOption
						key={`${first.id}-${first.inputFingerprint}`}
						advice={first}
						goal={goal}
						onAdopt={adopt}
						onKeep={keep}
						onApplySelected={applySelected}
						locale={locale}
					/>
					{items.length > 1 ? (
						<details className="space-y-3 text-xs text-zinc-400">
							<summary className="cursor-pointer">
								{ja ? "ほかの案" : "Other adjustments"}
							</summary>
							{items.slice(1).map((item) => (
								<AdviceOption
									key={`${item.id}-${item.inputFingerprint}`}
									advice={item}
									goal={goal}
									onAdopt={adopt}
									onKeep={keep}
									onApplySelected={applySelected}
									locale={locale}
								/>
							))}
						</details>
					) : null}
				</section>
			) : null}
		</div>
	);
}
