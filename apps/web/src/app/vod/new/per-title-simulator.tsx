"use client";

import type {
	PerTitleDiagnostic,
	PerTitleGoal,
	PerTitleProposal,
} from "@bitovp/core";
import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import type { Locale } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
} from "./per-title-simulator-advice";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";
import {
	bitrateSliderBounds,
	type PerTitleManualBounds,
} from "./per-title-simulator-auto";
import { PerTitleConstraints } from "./per-title-simulator-constraints";
import {
	PerTitleGlobalControls,
	PerTitleSettingControl,
	PerTitleStreamControls,
} from "./per-title-simulator-controls";
import {
	type PerTitleSimulatorCopy,
	perTitleSimulatorCopy,
} from "./per-title-simulator-copy";
import { PerTitleSimulatorNumberField as NumberField } from "./per-title-simulator-fields";
import { PerTitleSimulatorFiles } from "./per-title-simulator-files";
import type { PerTitleReference } from "./per-title-simulator-preset";
import { PerTitleReasoning } from "./per-title-simulator-reasoning";
import { PerTitleRecommendation } from "./per-title-simulator-recommendation";
import { PerTitleSimulatorRows } from "./per-title-simulator-rows";
import {
	initializePerTitleSettings,
	perTitleGlobalFields,
	perTitleStreamFields,
	setPerTitleAdjustment,
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

export type PerTitleSimulatorProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialGoal: PerTitleGoal;
	/** Seeds loaded the first time a codec is selected in this session. */
	goalsByCodec?: Partial<Record<PerTitleGoal["codec"], PerTitleGoal>>;
	onApply: (proposal: PerTitleProposal) => void;
	applyError?: string | null;
};

const usesRows = (goal: PerTitleGoal) =>
	goal.strategy !== "automatic" && goal.strategy !== "count";

const validSliderBitrate = (value: number) =>
	Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

const diagnosticJa: Record<PerTitleDiagnostic["code"], string> = {
	"invalid-setting": "Per-Title の設定値または調整方法を確認してください。",
	"model-only":
		"許容範囲とビットレート間隔から計算した例です。素材の解析や、エンコーダの出力の予測は行いません。",
	"invalid-global-range":
		"全体の最小・最大ビットレートを、1 bps 以上の整数で、小さい順に指定してください。",
	"invalid-step":
		"ビットレート間隔は1より大きい比率で指定し、下限が上限を超えないようにしてください。",
	"invalid-count": "希望する本数を1〜256の整数で指定してください。",
	"count-required": "本数を指定する用途では、希望する本数を入力してください。",
	"rows-required": "必須の解像度を1行以上追加してください。",
	"invalid-row":
		"行の識別子が重複していないことと、寸法が1以上の整数であることを確認してください。",
	"invalid-row-range":
		"各行の最小・最大ビットレートを、1 bps 以上の整数で、小さい順に指定してください。",
	"row-outside-global-range":
		"行のビットレート範囲が、全体の範囲を超えています。",
	"invalid-complexity-range":
		"COMPLEXITY_RANGE の下側・上側境界を1 bps 以上の整数で指定し、上側が下側より大きくなるようにしてください。",
	"required-count-exceeded": "必須の行数が、希望する総本数を超えています。",
	"row-step-conflict":
		"間隔の下限を守ると、指定した範囲に必須の行をすべて配置できません。",
	"row-gap-conflict":
		"必須の行をつなぐには、間隔の上限を広げるか、間にビットレートの点を追加する必要があります。",
	"count-unreachable":
		"このモデルの本数の範囲には、希望する本数が含まれません。",
	"extra-rungs-possible":
		"このモデルでは、許容範囲内に追加のビットレートを配置できる余地があります。希望する本数を超える場合は条件の調整が必要です。",
	"count-not-guaranteed":
		"希望する本数は要件として扱います。Encoding API の指定項目でも、出力本数の保証でもありません。",
	"complexity-analysis-required":
		"複雑度の境界は設定へ引き継ぎます。この計算例では、未解析の素材に対する効果は推定しません。",
	"upscale-required":
		"必須の解像度が、入力素材として指定された高さを超えています。",
	"step-adjusted":
		"変更するのはビットレート間隔だけです。指定した解像度とビットレート範囲は維持します。",
	"model-limit":
		"このモデルの上限は、自動追加分を含む64テンプレート・9シナリオ・256のビットレート点です。間隔の下限や入力件数、シナリオの仮定値を確認してください。",
	"row-order-unknown":
		"指定した寸法と範囲だけでは、エンコーダーが各段を処理する順序を確認できません。同じ解像度の段の解析結果や、未指定の横幅を確認する必要があります。この結果だけで要件が実現できないとは判定しません。",
	"linear-illustration":
		"COMPLEXITY_RANGE の各点は、仮定した上端ビットレートを使い、行の最小・最大ビットレートの間を線形補間した例です。境界の外では最小値または最大値に収めます。",
	"scenario-range-bound":
		"本数の範囲は、指定した許容範囲全体から求めたものです。このシナリオに示すビットレートの点とは別に計算しています。",
	"scenario-conflict": perTitleSimulatorCopy.ja.internalCheckDifference,
	"forced-count-unknown":
		"追加レンディションのルールを保持しています。このルールを含む出力本数は、素材解析なしには算出できません。",
	"inactive-template-settings":
		perTitleSimulatorCopy.ja.inactiveTemplateSettings,
};

const tableClasses =
	"w-full text-left text-xs text-zinc-300 [&_th]:px-2 [&_th]:py-2 [&_th]:font-medium [&_td]:px-2 [&_td]:py-2 [&_tbody_tr]:border-t [&_tbody_tr]:border-zinc-800";

function DiagnosticList({
	items,
	rows,
	locale,
	copy,
	technicalDetails = true,
}: {
	items: PerTitleDiagnostic[];
	rows: PerTitleGoal["rows"];
	locale: Locale;
	copy: PerTitleSimulatorCopy;
	technicalDetails?: boolean;
}) {
	return (
		<ul className="space-y-2 text-xs">
			{items.map((item, index) => (
				<li
					key={`${item.code}-${index}`}
					className={
						item.severity === "conflict"
							? "text-red-300"
							: item.severity === "warning"
								? "text-amber-300"
								: "text-zinc-400"
					}
				>
					{item.severity === "conflict" ? (
						<span className="font-medium">{copy.conflict}: </span>
					) : null}
					{item.code === "inactive-template-settings"
						? copy.inactiveTemplateSettings
						: item.code === "scenario-conflict"
							? copy.internalCheckDifference
							: locale === "ja"
								? item.code === "row-step-conflict" &&
									item.values?.ratio !== undefined
									? "この計算例では、隣り合うビットレートの比率が指定した間隔の範囲に収まりません。"
									: diagnosticJa[item.code]
								: item.message}
					{technicalDetails &&
					item.rowIds?.length &&
					item.rowIds.every((rowId) =>
						rows?.some((row) => row.id === rowId),
					) ? (
						<span className="ml-1">
							({copy.rowReference}{" "}
							{item.rowIds
								.map(
									(rowId) =>
										(rows?.findIndex((row) => row.id === rowId) ?? -1) + 1,
								)
								.join(", ")}
							)
						</span>
					) : null}
					{technicalDetails && item.values ? (
						<span className="ml-1 font-mono text-zinc-400">
							(
							{Object.entries(item.values)
								.map(
									([key, value]) =>
										`${key}=${typeof value === "number" ? Number(value.toPrecision(6)) : value}`,
								)
								.join(", ")}
							)
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

function ProposalResults({
	selected,
	baseline,
	goal,
	referenceGoal,
	rows,
	copy,
	locale,
	id,
}: {
	selected: PerTitleProposal;
	baseline: PerTitleProposal;
	goal: PerTitleGoal;
	referenceGoal: PerTitleGoal;
	rows: PerTitleGoal["rows"];
	copy: PerTitleSimulatorCopy;
	locale: Locale;
	id: string;
}) {
	const format = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
	const countGoal = (value: PerTitleGoal) =>
		value.countPolicy.kind === "unrestricted"
			? copy.countPolicies.unrestricted
			: `${copy.countPolicies[value.countPolicy.kind]} (${value.countPolicy.count})`;
	const proposals = [baseline, selected];
	if (!selected)
		return (
			<p role="status" className="text-sm text-zinc-400">
				{copy.empty}
			</p>
		);
	const countsByHeight = new Map<number, number>();
	for (const stream of selected.api.streams) {
		if (stream.mode !== "PER_TITLE_TEMPLATE" && stream.height !== undefined) {
			countsByHeight.set(
				stream.height,
				(countsByHeight.get(stream.height) ?? 0) + 1,
			);
		}
	}
	return (
		<div className="space-y-4 border-t border-zinc-800 pt-4">
			<section aria-labelledby={`${id}-comparison`} className="space-y-3">
				<h3
					id={`${id}-comparison`}
					className="font-medium text-sm text-zinc-200"
				>
					{copy.comparison}
				</h3>
				<div className="overflow-x-auto">
					<table className={tableClasses} aria-label={copy.comparison}>
						<thead>
							<tr>
								<th scope="col">{copy.parameter}</th>
								<th scope="col">{copy.baseline}</th>
								<th scope="col">{copy.adjusted}</th>
							</tr>
						</thead>
						<tbody>
							{(
								[
									[copy.minimum, "minBitrate"],
									[copy.maximum, "maxBitrate"],
								] as const
							).map(([label, key]) => (
								<tr key={key}>
									<th scope="row">{label}</th>
									<td>{format(referenceGoal[key] / 1000)}</td>
									<td>{format(goal[key] / 1000)}</td>
								</tr>
							))}
							<tr>
								<th scope="row">{copy.countPolicy}</th>
								<td>{countGoal(referenceGoal)}</td>
								<td>{countGoal(goal)}</td>
							</tr>
							<tr>
								<th scope="row">{copy.autoRepresentations}</th>
								{proposals.map((proposal, index) => (
									<td key={index === 0 ? "loaded" : "edited"}>
										{proposal.api.global.autoRepresentations
											? copy.enabled
											: copy.disabled}
									</td>
								))}
							</tr>
						</tbody>
					</table>
				</div>
			</section>
			<section aria-labelledby={`${id}-diagnostics`} className="space-y-2">
				<h3
					id={`${id}-diagnostics`}
					className="font-medium text-sm text-zinc-200"
				>
					{copy.diagnostics}
				</h3>
				<DiagnosticList
					items={selected.diagnostics}
					rows={rows}
					locale={locale}
					copy={copy}
				/>
			</section>
			{countsByHeight.size ? (
				<section
					className="space-y-2"
					aria-labelledby={`${id}-resolution-counts`}
				>
					<h3
						id={`${id}-resolution-counts`}
						className="font-medium text-sm text-zinc-200"
					>
						{copy.resolutionCounts}
					</h3>
					<p className="text-xs text-zinc-400">{copy.resolutionCountHint}</p>
					<div className="overflow-x-auto">
						<table className={tableClasses} aria-label={copy.resolutionCounts}>
							<thead>
								<tr>
									<th scope="col">{copy.resolution}</th>
									<th scope="col">{copy.requiredCount}</th>
									<th scope="col">{copy.additionalCapacity}</th>
								</tr>
							</thead>
							<tbody>
								{[...countsByHeight]
									.sort(([a], [b]) => a - b)
									.map(([height, count]) => (
										<tr key={height}>
											<th scope="row">{height}</th>
											<td>{count}</td>
											<td>{copy.notEvaluated}</td>
										</tr>
									))}
							</tbody>
						</table>
					</div>
				</section>
			) : null}
			<details className="text-xs text-zinc-400">
				<summary className="cursor-pointer">{copy.apiSettings}</summary>
				<p className="mt-2">{copy.apiHint}</p>
				<pre
					data-testid="per-title-api-settings"
					className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-zinc-900 p-3 text-xs text-zinc-300"
				>
					{JSON.stringify(selected.api, null, 2)}
				</pre>
			</details>
		</div>
	);
}

function SimulatorEditor({
	initialGoal,
	goalsByCodec,
	onOpenChange,
	onApply,
	applyError,
	goal: draftGoal,
	setGoal,
	manualBounds,
	onBitrateChange,
	onResetBitrates,
	referenceGoal,
	reference,
	onLoad,
	onCodecChange,
}: PerTitleSimulatorProps & {
	goal: PerTitleGoal;
	setGoal: Dispatch<SetStateAction<PerTitleGoal>>;
	manualBounds: PerTitleManualBounds;
	onBitrateChange: (
		rowId: string,
		bound: "min" | "max",
		value: number | undefined,
	) => void;
	onResetBitrates: (rowId: string) => void;
	referenceGoal: PerTitleGoal;
	reference?: PerTitleReference;
	onLoad: (goal: PerTitleGoal, reference?: PerTitleReference) => void;
	onCodecChange: (codec: PerTitleGoal["codec"]) => void;
}) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const id = useId();
	const tuned = useMemo(
		() => tunePerTitleSettings(draftGoal, referenceGoal),
		[draftGoal, referenceGoal],
	);
	const { goal, proposal: selected } = tuned;
	const controlContext = {
		draft: draftGoal,
		anchor: referenceGoal,
		proposal: selected,
		onChange: setGoal,
	};
	const slider = useMemo(
		() => bitrateSliderBounds(referenceGoal),
		[referenceGoal],
	);
	const renditionSession = useMemo(
		() => JSON.stringify(referenceGoal),
		[referenceGoal],
	);
	const [sliderRange, setSliderRange] = useState({
		baseline: referenceGoal,
		maximum: slider.max,
	});
	useEffect(() => {
		setSliderRange((current) => {
			const baselineMaximum =
				current.baseline === referenceGoal ? current.maximum : slider.max;
			const maximum = Math.max(
				baselineMaximum,
				validSliderBitrate(goal.maxBitrate) ? goal.maxBitrate : baselineMaximum,
			);
			return current.baseline === referenceGoal && current.maximum === maximum
				? current
				: { baseline: referenceGoal, maximum };
		});
	}, [referenceGoal, goal.maxBitrate, slider.max]);
	const sliderMinimum = validSliderBitrate(goal.minBitrate)
		? goal.minBitrate
		: slider.min;
	const sliderMaximum = Math.max(
		sliderRange.baseline === referenceGoal ? sliderRange.maximum : slider.max,
		validSliderBitrate(goal.maxBitrate) ? goal.maxBitrate : slider.max,
		sliderMinimum,
	);
	const sliderValid =
		validSliderBitrate(goal.minBitrate) &&
		validSliderBitrate(goal.maxBitrate) &&
		goal.maxBitrate >= goal.minBitrate;
	const baseline = useMemo(
		() => tunePerTitleSettings(referenceGoal, referenceGoal).proposal,
		[referenceGoal],
	);
	const patch = (next: Partial<PerTitleGoal>) =>
		setGoal((current) => ({ ...current, ...next }));
	return (
		<div className="space-y-5">
			<PerTitleSimulatorFiles
				goal={goal}
				reference={reference}
				allowedCodecs={[
					"H264",
					"H265",
					"VP9",
					"AV1",
					...(initialGoal.codec === "H265V2" || goalsByCodec?.H265V2
						? ["H265V2" as const]
						: []),
				]}
				onLoad={onLoad}
			/>
			<div className="grid gap-5 lg:grid-cols-2">
				<div className="space-y-5">
					<Field htmlFor={`${id}-codec`} label={copy.codec}>
						<SelectNative
							id={`${id}-codec`}
							value={goal.codec}
							onChange={(event) =>
								onCodecChange(event.target.value as PerTitleGoal["codec"])
							}
						>
							{(
								[
									"H264",
									"H265",
									"VP9",
									"AV1",
									...(initialGoal.codec === "H265V2" || goalsByCodec?.H265V2
										? ["H265V2"]
										: []),
								] as const
							).map((codec) => (
								<option key={codec} value={codec}>
									{codec}
								</option>
							))}
						</SelectNative>
					</Field>
					<Field htmlFor={`${id}-strategy`} label={copy.strategy}>
						<SelectNative
							id={`${id}-strategy`}
							value={goal.strategy}
							onChange={(event) => {
								const strategy = event.target.value as PerTitleGoal["strategy"];
								patch({
									strategy,
									...(strategy === "fixed-ranges"
										? {
												rows: goal.rows?.map((row) => ({
													...row,
													minBitrate: row.minBitrate ?? goal.minBitrate,
													maxBitrate: row.maxBitrate ?? goal.maxBitrate,
												})),
											}
										: {}),
									...(strategy === "count" &&
									goal.countPolicy.kind === "unrestricted"
										? { countPolicy: { kind: "exact", count: 6 } }
										: {}),
								});
							}}
						>
							{Object.entries(copy.strategies).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</SelectNative>
					</Field>
					<section className="space-y-3" aria-labelledby={`${id}-global`}>
						<h3
							id={`${id}-global`}
							className="font-medium text-sm text-zinc-200"
						>
							{copy.global}
						</h3>
						<div className="grid gap-3 sm:grid-cols-2">
							{perTitleGlobalFields(goal.codec)
								.filter((field) => field.group === "range")
								.map((field) => (
									<PerTitleSettingControl
										key={field.key}
										id={`${id}-${field.key}`}
										context={controlContext}
										scope="global"
										field={field}
										label={
											field.key === "minBitrate" ? copy.minimum : copy.maximum
										}
										slider={{
											label:
												field.key === "minBitrate"
													? copy.minimumSlider
													: copy.maximumSlider,
											minimum: field.key === "minBitrate" ? 1 : sliderMinimum,
											maximum:
												field.key === "minBitrate"
													? goal.maxBitrate
													: sliderMaximum,
											keyboardStep: slider.step,
											disabled: !sliderValid,
										}}
									/>
								))}
						</div>
					</section>
					<div className="grid gap-3 sm:grid-cols-2">
						<Field htmlFor={`${id}-count-policy`} label={copy.countPolicy}>
							<SelectNative
								id={`${id}-count-policy`}
								value={goal.countPolicy.kind}
								onChange={(event) => {
									const kind = event.target
										.value as PerTitleGoal["countPolicy"]["kind"];
									patch({
										countPolicy:
											kind === "unrestricted"
												? { kind }
												: {
														kind,
														count:
															goal.countPolicy.kind === "unrestricted"
																? 6
																: goal.countPolicy.count,
													},
									});
								}}
							>
								{Object.entries(copy.countPolicies).map(([value, label]) => (
									<option
										key={value}
										value={value}
										disabled={
											value === "unrestricted" && goal.strategy === "count"
										}
									>
										{label}
									</option>
								))}
							</SelectNative>
						</Field>
						{goal.countPolicy.kind !== "unrestricted" ? (
							<NumberField
								id={`${id}-count`}
								label={copy.count}
								value={goal.countPolicy.count}
								minimum={1}
								integer
								onChange={(value) => {
									if (goal.countPolicy.kind !== "unrestricted")
										patch({
											countPolicy: {
												...goal.countPolicy,
												count: value ?? Number.NaN,
											},
										});
								}}
							/>
						) : null}
					</div>
					<PerTitleGlobalControls
						id={`${id}-parameters`}
						context={controlContext}
					/>
					{usesRows(goal) ? (
						<PerTitleSimulatorRows
							key={renditionSession}
							id={id}
							goal={goal}
							onChange={setGoal}
							manualBounds={manualBounds}
							onBitrateChange={onBitrateChange}
							onResetBitrates={onResetBitrates}
							tuning={controlContext}
						/>
					) : (
						<div className="space-y-3">
							{selected.api.streams.map((stream, index) => (
								<section
									key={stream.rowId}
									aria-label={`${copy.rowReference} ${index + 1}`}
									className="space-y-2"
								>
									<code className="text-xs text-zinc-400">{stream.mode}</code>
									<PerTitleStreamControls
										id={`${id}-${stream.rowId}-settings`}
										context={controlContext}
										rowId={stream.rowId}
										suffix={`${copy.rendition} ${index + 1}`}
									/>
								</section>
							))}
						</div>
					)}
				</div>
				<div className="min-w-0 space-y-4 overflow-x-clip lg:sticky lg:top-0 lg:self-start">
					<PerTitleAdvisor
						goal={goal}
						session={referenceGoal}
						onAdopt={(advice, options, fields) =>
							setGoal((current) => {
								const normalized = tunePerTitleSettings(
									current,
									referenceGoal,
								).goal;
								return (
									(fields
										? applySelectedPerTitleAdvice(
												normalized,
												advice,
												fields,
												options,
											)
										: applyPerTitleAdvice(normalized, advice, options)) ??
									current
								);
							})
						}
					/>
					<PerTitleRecommendation
						goal={goal}
						proposal={selected}
						baseline={baseline}
						axis={{ minimum: slider.min, maximum: slider.max }}
						comparisonOnly={!!reference}
					/>
					<PerTitleReasoning
						goal={goal}
						proposal={selected}
						onChange={setGoal}
						showSuggestions={false}
					/>
					<PerTitleConstraints proposal={selected} />
				</div>
			</div>
			<details className="border-t border-zinc-800 pt-4 text-xs text-zinc-400">
				<summary className="cursor-pointer">{copy.calculationDetails}</summary>
				<div className="space-y-2 pt-3">
					<p>{copy.codecHint}</p>
					<p>{copy.countHint}</p>
					<p>{copy.automaticSteps}</p>
					{goal.strategy === "fixed-ranges" ? (
						<p>{copy.automaticRanges}</p>
					) : null}
					{usesRows(goal) ? <p>{copy.rowsHint}</p> : null}
					{reference ? <p>{copy.referenceHint}</p> : null}
				</div>
				<ProposalResults
					selected={selected}
					baseline={baseline}
					goal={goal}
					referenceGoal={referenceGoal}
					rows={goal.rows}
					copy={copy}
					locale={locale}
					id={id}
				/>
			</details>
			{applyError ? (
				<p role="alert" className="text-red-400 text-sm">
					{applyError}
				</p>
			) : null}
			<div className="flex flex-wrap justify-end gap-2 border-t border-zinc-800 pt-4">
				<Button variant="secondary" onClick={() => onOpenChange(false)}>
					{copy.cancel}
				</Button>
				<Button
					disabled={!selected.applicable || !!reference}
					onClick={() => {
						if (selected.applicable && !reference) onApply(selected);
					}}
				>
					{copy.apply}
				</Button>
			</div>
		</div>
	);
}

function copyGoal(goal: PerTitleGoal): PerTitleGoal {
	return initializePerTitleSettings(goal);
}

function projectCodecSettings(
	goal: PerTitleGoal,
	codec: PerTitleGoal["codec"],
): PerTitleGoal {
	const next = copyGoal(goal);
	const codecs: PerTitleGoal["codec"][] = [
		"H264",
		"H265",
		"H265V2",
		"VP9",
		"AV1",
	];
	const globalKeys = new Set(perTitleGlobalFields(codec).map(({ key }) => key));
	const streamKeys = new Set(perTitleStreamFields(codec).map(({ key }) => key));
	// Quality values are codec-specific, even when both codecs use CRF.
	globalKeys.delete("targetQualityCrf");
	globalKeys.delete("targetQualityQp");
	for (const field of codecs.flatMap(perTitleGlobalFields)) {
		if (!globalKeys.has(field.key)) Reflect.deleteProperty(next, field.key);
	}
	for (const row of [
		...(next.rows ?? []),
		...(next.automaticTemplates ?? []),
	]) {
		for (const field of codecs.flatMap(perTitleStreamFields)) {
			if (!streamKeys.has(field.key)) Reflect.deleteProperty(row, field.key);
		}
	}
	if (next.adjustments) {
		const supported = (
			policies: NonNullable<PerTitleGoal["adjustments"]>["global"],
			keys: Set<string>,
		) =>
			Object.fromEntries(
				Object.entries(policies ?? {}).filter(([key]) => keys.has(key)),
			);
		next.adjustments = {
			...next.adjustments,
			global: supported(next.adjustments.global, globalKeys),
			streams: Object.fromEntries(
				Object.entries(next.adjustments.streams ?? {}).map(([id, policies]) => [
					id,
					supported(policies, streamKeys),
				]),
			),
		};
	}
	delete next.settingLocks;
	return next;
}

export function PerTitleSimulator(props: PerTitleSimulatorProps) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const [goal, setGoal] = useState(() => copyGoal(props.initialGoal));
	const [referenceGoal, setReferenceGoal] = useState(() =>
		copyGoal(props.initialGoal),
	);
	const [reference, setReference] = useState<PerTitleReference>();
	const [manualBounds, setManualBounds] = useState<PerTitleManualBounds>({});
	const [codecError, setCodecError] = useState(false);
	const drafts = useRef(
		new Map<
			PerTitleGoal["codec"],
			{
				goal: PerTitleGoal;
				referenceGoal: PerTitleGoal;
				reference?: PerTitleReference;
				manualBounds: PerTitleManualBounds;
			}
		>(),
	);
	const draftId = useId();
	const nextRowId = useRef(0);
	function switchCodec(codec: PerTitleGoal["codec"]) {
		if (codec === goal.codec) return;
		drafts.current.set(goal.codec, {
			goal: copyGoal(goal),
			referenceGoal: copyGoal(referenceGoal),
			reference,
			manualBounds: structuredClone(manualBounds),
		});
		const cached = drafts.current.get(codec);
		if (cached) {
			setCodecError(false);
			setGoal(copyGoal(cached.goal));
			setReferenceGoal(copyGoal(cached.referenceGoal));
			setReference(cached.reference);
			setManualBounds(structuredClone(cached.manualBounds));
			return;
		}
		const seed = props.goalsByCodec?.[codec];
		if (reference && seed?.codec !== codec) {
			setCodecError(true);
			return;
		}
		setCodecError(false);
		setManualBounds({});
		if (seed?.codec === codec) {
			setGoal(copyGoal(seed));
			setReferenceGoal(copyGoal(seed));
		} else {
			const reservedIds = new Set<string>();
			for (const known of [
				props.initialGoal,
				goal,
				...Object.values(props.goalsByCodec ?? {}),
				...[...drafts.current.values()].map((draft) => draft.goal),
			]) {
				for (const row of [
					...(known?.rows ?? []),
					...(known?.automaticTemplates ?? []),
				])
					reservedIds.add(row.id);
			}
			const freshId = () => {
				let rowId: string;
				do {
					nextRowId.current += 1;
					rowId = `${draftId}-${codec}-new-${nextRowId.current}`;
				} while (reservedIds.has(rowId));
				reservedIds.add(rowId);
				return rowId;
			};
			const inherited = projectCodecSettings(
				tunePerTitleSettings(goal, referenceGoal).goal,
				codec,
			);
			const remapped = new Map<string, string>();
			const rowId = (previous: string) => {
				const next = freshId();
				remapped.set(previous, next);
				return next;
			};
			const next = {
				...copyGoal(inherited),
				codec,
				rows: inherited.rows?.map((row) => ({ ...row, id: rowId(row.id) })),
				automaticTemplates: inherited.automaticTemplates?.map((row) => ({
					...row,
					id: rowId(row.id),
				})),
			};
			if (next.adjustments?.streams)
				next.adjustments = {
					...next.adjustments,
					streams: Object.fromEntries(
						Object.entries(next.adjustments.streams).flatMap(([id, value]) => {
							const target = remapped.get(id);
							return target ? [[target, value]] : [];
						}),
					),
				};
			setGoal(next);
			setReferenceGoal(copyGoal(next));
		}
		setReference(undefined);
	}
	function loadGoal(next: PerTitleGoal, loadedReference?: PerTitleReference) {
		setCodecError(false);
		drafts.current.set(goal.codec, {
			goal: copyGoal(goal),
			referenceGoal: copyGoal(referenceGoal),
			reference,
			manualBounds: structuredClone(manualBounds),
		});
		setGoal(copyGoal(next));
		setReferenceGoal(copyGoal(next));
		setManualBounds({});
		setReference(loadedReference);
	}
	function changeBitrate(
		rowId: string,
		bound: "min" | "max",
		value: number | undefined,
	) {
		setGoal((current) =>
			setPerTitleSetting(
				current,
				"stream",
				bound === "min" ? "minBitrate" : "maxBitrate",
				value ?? Number.NaN,
				rowId,
			),
		);
		setManualBounds((current) => ({
			...current,
			[rowId]: { ...current[rowId], [bound]: true },
		}));
	}
	function resetBitrates(rowId: string) {
		setGoal((current) => {
			const proposal = tunePerTitleSettings(current, referenceGoal).proposal;
			let next = setPerTitleAdjustment(
				current,
				proposal,
				"stream",
				"minBitrate",
				{ mode: "auto", method: "logarithmic" },
				rowId,
			);
			next = setPerTitleAdjustment(
				next,
				proposal,
				"stream",
				"maxBitrate",
				{ mode: "auto", method: "logarithmic" },
				rowId,
			);
			return next;
		});
		setManualBounds((current) => {
			const next = { ...current };
			delete next[rowId];
			return next;
		});
	}
	function changeOpen(open: boolean) {
		if (!open) {
			setCodecError(false);
			drafts.current.clear();
			setGoal(copyGoal(props.initialGoal));
			setReferenceGoal(copyGoal(props.initialGoal));
			setReference(undefined);
			setManualBounds({});
		}
		props.onOpenChange(open);
	}
	return (
		<Dialog open={props.open} onOpenChange={changeOpen} title={copy.title} wide>
			<SimulatorEditor
				{...props}
				applyError={codecError ? copy.referenceCodecError : props.applyError}
				onOpenChange={changeOpen}
				goal={goal}
				setGoal={setGoal}
				manualBounds={manualBounds}
				onBitrateChange={changeBitrate}
				onResetBitrates={resetBitrates}
				referenceGoal={referenceGoal}
				reference={reference}
				onLoad={loadGoal}
				onCodecChange={switchCodec}
			/>
		</Dialog>
	);
}
