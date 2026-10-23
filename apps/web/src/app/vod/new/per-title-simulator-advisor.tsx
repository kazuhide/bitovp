"use client";

import type { PerTitleGoal } from "@bitovp/core";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	applyPerTitleAdvice,
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
import { PerTitleAdvicePreview } from "./per-title-simulator-advice-preview";
import {
	analyzePerTitleSettings,
	type PerTitleAnalysisIntent,
	type PerTitleAnalysisResult,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import {
	PerTitleAnalysisDetails,
	PerTitleAnalysisPanel,
} from "./per-title-simulator-analysis-panel";
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

function sameFieldValue(
	before: PerTitleGoal,
	after: PerTitleGoal,
	field: PerTitleAdviceField,
) {
	return Object.is(
		getPerTitleGoalSetting(before, field.scope, field.key, field.rowId),
		getPerTitleGoalSetting(after, field.scope, field.key, field.rowId),
	);
}

function AdviceOption({
	advice,
	goal,
	onAdopt,
	onReview,
	applying,
	pendingFields,
	options,
	locale,
}: {
	advice: PerTitleAdvice;
	goal: PerTitleGoal;
	onAdopt: (advice: PerTitleAdvice) => void;
	onReview: (
		advice: PerTitleAdvice,
		selected: PerTitleAdviceField[],
		kept: PerTitleAdviceField[],
	) => boolean;
	applying: boolean;
	pendingFields: readonly PerTitleAdviceField[];
	options: PerTitleAdviceOptions;
	locale: Locale;
}) {
	const ja = locale === "ja";
	const reason = {
		evaluation: ja
			? "現在の条件と維持する値に合わせた調整案です。"
			: "Adjust the current settings while preserving your conditions and maintained values.",
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
		<div className="min-w-0 space-y-3">
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale={locale}
				onReview={onReview}
				onAdoptAll={onAdopt}
				applying={applying}
				pendingFields={pendingFields}
				renderPreview={({ selected, kept }) =>
					applying ? null : (
						<PerTitleAdvicePreview
							goal={goal}
							advice={advice}
							options={options}
							selected={selected}
							kept={kept}
						/>
					)
				}
			/>
			<details className="space-y-2 text-xs text-zinc-400">
				<summary className="cursor-pointer">
					{ja ? "根拠と確認範囲" : "Reasoning and scope"}
				</summary>
				<p>{advice.explanation?.[locale] ?? reason}</p>
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
		</div>
	);
}

const EMPTY_FIELDS: readonly PerTitleAdviceField[] = [];
const protectionKey = (fields: readonly PerTitleAdviceField[]) =>
	JSON.stringify(fields.map(perTitleAdviceFieldKey).sort());

type AdvisorContext =
	| {
			kind: "edit";
			before: PerTitleGoal;
			edit: PerTitleAdviceEdit;
			appliedFields: readonly PerTitleAdviceField[];
	  }
	| { kind: "analysis"; intent: PerTitleAnalysisIntent };

type AdvisorSnapshot = {
	revision?: number;
	goal: PerTitleGoal;
	session: PerTitleGoal;
	key: string;
	contextKey?: string;
	items: PerTitleAdvice[];
	analysis?: PerTitleAnalysisResult;
};

function analysisSnapshot(
	goal: PerTitleGoal,
	session: PerTitleGoal,
	fields: readonly PerTitleAdviceField[],
	intent: PerTitleAnalysisIntent,
): AdvisorSnapshot {
	const contextKey = perTitleAnalysisContextKey(intent);
	const analysis = analyzePerTitleSettings(goal, intent, {
		protectedFields: fields,
		contextKey,
		referenceGoal: session,
	});
	return {
		goal,
		session,
		key: protectionKey(fields),
		contextKey,
		items: analysis.advice,
		analysis,
	};
}

/** Keep continuous edits and retained fields scoped to the loaded simulator session. */
export function PerTitleAdvisor({
	goal,
	session,
	onAdopt,
	onInspectField,
}: {
	goal: PerTitleGoal;
	session: PerTitleGoal;
	onAdopt: (
		advice: PerTitleAdvice,
		options?: PerTitleAdviceOptions,
		selected?: readonly PerTitleAdviceField[],
	) => void;
	onInspectField?: (field: PerTitleAdviceField) => void;
}) {
	const { locale } = useT();
	const ja = locale === "ja";
	const id = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const pendingFocus = useRef<string | null>(null);
	const previous = useRef({ goal, session });
	const [intent, setIntent] = useState<PerTitleAnalysisIntent>("cap");
	const liveIntent = useRef(intent);
	const active = useRef<AdvisorContext | null>(null);
	const [, refreshPending] = useState(0);
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
		() => ({ protectedFields: fields, referenceGoal: session }),
		[fields, session],
	);
	const key = protectionKey(fields);
	const [snapshot, setSnapshot] = useState<AdvisorSnapshot | null>(null);
	const revision = useRef(0);
	const replaceSnapshot = useCallback((next: AdvisorSnapshot | null) => {
		setSnapshot(next ? { ...next, revision: ++revision.current } : null);
	}, []);

	useEffect(() => {
		const prior = previous.current;
		previous.current = { goal, session };
		if (prior.session !== session || prior.goal.codec !== goal.codec) {
			active.current = null;
			pendingApplication.current = null;
			pendingFocus.current = null;
			replaceSnapshot(null);
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
			replaceSnapshot(null);
			liveProtection.current = { session, codec: goal.codec, fields: retained };
			setProtection(liveProtection.current);
			return;
		}
		if (prior.goal !== goal && pendingApplication.current) {
			const pending = pendingApplication.current;
			pendingApplication.current = null;
			if (samePerTitleAdviceInput(goal, pending.goal)) {
				active.current =
					pending.complete && pending.active.kind === "edit"
						? null
						: pending.active;
				if (pending.active.kind === "analysis")
					replaceSnapshot(
						analysisSnapshot(
							goal,
							session,
							pending.fields,
							pending.active.intent,
						),
					);
				else if (pending.complete) replaceSnapshot(null);
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
		if (prior.goal !== goal && active.current?.kind !== "analysis") {
			pendingFocus.current = null;
			const edit = singleEdit(prior.goal, goal);
			if (!edit) {
				active.current = null;
				replaceSnapshot(
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
				active.current = {
					kind: "edit",
					before: prior.goal,
					edit,
					appliedFields: [],
				};
		}
		if (active.current?.kind === "analysis")
			replaceSnapshot(
				analysisSnapshot(goal, session, fields, active.current.intent),
			);
		else if (active.current)
			replaceSnapshot({
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
	}, [goal, session, key, options, fields, replaceSnapshot]);
	const matches =
		snapshot?.goal === goal &&
		snapshot.session === session &&
		snapshot.key === key &&
		(!snapshot.analysis ||
			snapshot.contextKey === perTitleAnalysisContextKey(intent));
	const first = matches ? snapshot.items[0] : undefined;
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
	const changeIntent = (next: PerTitleAnalysisIntent) => {
		liveIntent.current = next;
		active.current = null;
		pendingApplication.current = null;
		pendingFocus.current = null;
		replaceSnapshot(null);
		setIntent(next);
	};
	const evaluate = () => {
		const live = liveProtection.current;
		if (
			pendingApplication.current ||
			live.session !== session ||
			live.codec !== goal.codec
		)
			return;
		active.current = { kind: "analysis", intent: liveIntent.current };
		pendingApplication.current = null;
		pendingFocus.current = null;
		replaceSnapshot(
			analysisSnapshot(goal, session, live.fields, liveIntent.current),
		);
	};
	const keep = (added: PerTitleAdviceField[]) => {
		const current =
			liveProtection.current.session === session &&
			liveProtection.current.codec === goal.codec
				? liveProtection.current.fields
				: EMPTY_FIELDS;
		const withAddedFields = (fields: readonly PerTitleAdviceField[]) => [
			...new Map(
				[...fields, ...added].map((field) => [
					perTitleAdviceFieldKey(field),
					field,
				]),
			).values(),
		];
		// Keep later pin actions in the delayed set without publishing selected fields.
		const pending = pendingApplication.current;
		if (pending) pending.fields = withAddedFields(pending.fields);
		pendingFocus.current = added[0] ? perTitleAdviceFieldKey(added[0]) : null;
		updateProtection(withAddedFields(current));
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
		const pending = pendingApplication.current;
		if (pending)
			pending.fields = pending.fields.filter(
				(item) =>
					perTitleAdviceFieldKey(item) !== perTitleAdviceFieldKey(field),
			);
		pendingFocus.current =
			active.current || remaining.length > 0 ? "adopt" : null;
		updateProtection(remaining);
	};
	const releaseForEvaluation = () => {
		const live = liveProtection.current;
		const relaxation = snapshot?.analysis?.relaxation;
		if (
			pendingApplication.current ||
			!matches ||
			active.current?.kind !== "analysis" ||
			snapshot.contextKey !== perTitleAnalysisContextKey(liveIntent.current) ||
			live.session !== session ||
			live.codec !== goal.codec ||
			protectionKey(live.fields) !== snapshot.key ||
			!relaxation ||
			!(relaxation.certifiedAlternatives > 0) ||
			relaxation.fields.length === 0
		)
			return;
		const held = new Set(live.fields.map(perTitleAdviceFieldKey));
		const release = new Set(relaxation.fields.map(perTitleAdviceFieldKey));
		if ([...release].some((key) => !held.has(key))) return;
		pendingFocus.current = "adopt";
		updateProtection(
			live.fields.filter(
				(field) => !release.has(perTitleAdviceFieldKey(field)),
			),
		);
	};
	const adoptionContextKey = () =>
		active.current?.kind === "analysis"
			? perTitleAnalysisContextKey(liveIntent.current)
			: undefined;
	const adopt = (advice: PerTitleAdvice) => {
		const live = liveProtection.current;
		if (
			pendingApplication.current ||
			!matches ||
			!snapshot.items.includes(advice) ||
			snapshot.contextKey !== adoptionContextKey() ||
			live.session !== session ||
			live.codec !== goal.codec ||
			protectionKey(live.fields) !== snapshot.key
		)
			return;
		const options = {
			protectedFields: live.fields.map((field) => ({ ...field })),
			referenceGoal: session,
			...(snapshot.contextKey === undefined
				? {}
				: { contextKey: perTitleAnalysisContextKey(liveIntent.current) }),
		};
		if (active.current?.kind === "analysis") {
			const next = applyPerTitleAdvice(goal, advice, options);
			if (!next) return;
			pendingApplication.current = {
				goal: next,
				active: active.current,
				fields: live.fields,
				complete: true,
			};
		} else {
			active.current = null;
			pendingApplication.current = null;
			replaceSnapshot(null);
		}
		refreshPending((value) => value + 1);
		onAdopt(advice, options);
	};
	const applySelected = (
		advice: PerTitleAdvice,
		selected: PerTitleAdviceField[],
		kept: PerTitleAdviceField[] = [],
	): boolean => {
		const live = liveProtection.current;
		if (
			!matches ||
			!active.current ||
			!snapshot.items.includes(advice) ||
			snapshot.contextKey !== adoptionContextKey() ||
			live.session !== session ||
			live.codec !== goal.codec ||
			protectionKey(live.fields) !== snapshot.key
		)
			return false;
		const decisions = [...selected, ...kept];
		const identities = decisions.map(perTitleAdviceFieldKey);
		if (
			decisions.length === 0 ||
			new Set(identities).size !== decisions.length ||
			decisions.some(
				(field) =>
					advice.changes.filter(
						(change) =>
							change.scope === field.scope &&
							change.key === field.key &&
							change.rowId === field.rowId,
					).length !== 1,
			)
		)
			return false;
		const pending = pendingApplication.current;
		if (
			pending &&
			(selected.length > 0 ||
				kept.some((field) => !sameFieldValue(goal, pending.goal, field)))
		)
			return false;
		const options = {
			protectedFields: live.fields.map((field) => ({ ...field })),
			referenceGoal: session,
			...(snapshot.contextKey === undefined
				? {}
				: { contextKey: perTitleAnalysisContextKey(liveIntent.current) }),
		};
		if (selected.length === 0) {
			if (!applyPerTitleAdvice(goal, advice, options)) return false;
			keep(kept);
			return true;
		}
		const next = applySelectedPerTitleAdvice(goal, advice, selected, options);
		if (!next) return false;
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
			active:
				active.current.kind === "analysis"
					? active.current
					: {
							...active.current,
							appliedFields: union(active.current.appliedFields, selected),
						},
			fields: union(union(live.fields, selected), kept),
			complete: advice.changes.every((change) =>
				selected.some(
					(field) =>
						perTitleAdviceFieldKey(field) === perTitleAdviceFieldKey(change),
				),
			),
		};
		// Publish only explicit keeps before the parent callback; selected pins await acknowledgement.
		if (kept.length > 0) updateProtection(union(live.fields, kept));
		refreshPending((value) => value + 1);
		onAdopt(advice, options, selected);
		return true;
	};
	const automatic =
		matches && !snapshot.analysis && hasAutomaticPerTitleSettings(goal);
	const unavailable =
		matches && !snapshot.analysis && fields.length > 0 && !first;
	const allRows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	const pending = pendingApplication.current;
	const pendingFields = pending
		? (first?.changes ?? []).filter(
				(field) => !sameFieldValue(goal, pending.goal, field),
			)
		: EMPTY_FIELDS;
	return (
		<div ref={rootRef} className="space-y-3">
			<PerTitleAnalysisPanel
				goal={goal}
				referenceGoal={session}
				intent={intent}
				onIntentChange={changeIntent}
				onEvaluate={evaluate}
				result={matches ? snapshot.analysis : undefined}
				onInspectField={onInspectField}
				onReleaseMaintained={releaseForEvaluation}
				applying={pending !== null}
			/>
			{first ? (
				<section
					aria-labelledby={id}
					className="min-w-0 space-y-3 rounded-md border border-zinc-700 p-3"
				>
					<h3 id={id} className="font-medium text-sm text-zinc-200">
						{ja ? "調整案" : "Suggested adjustment"}
					</h3>

					<AdviceOption
						key={`${snapshot?.revision}-${first.id}-${first.inputFingerprint}`}
						advice={first}
						goal={goal}
						onAdopt={adopt}
						onReview={applySelected}
						applying={pendingApplication.current !== null}
						pendingFields={pendingFields}
						options={{
							...options,
							...(snapshot?.contextKey === undefined
								? {}
								: { contextKey: snapshot.contextKey }),
						}}
						locale={locale}
					/>
				</section>
			) : null}
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
			<PerTitleAnalysisDetails
				goal={goal}
				result={matches ? snapshot.analysis : undefined}
				advice={first}
			/>
		</div>
	);
}
