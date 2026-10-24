"use client";

import type { PerTitleProposal } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";

const texts = {
	en: {
		title: "Parameter derivation",
		checked: "Interval and count conditions checked",
		checkedConditional: "Configuration checked under source conditions",
		unknown: "Joint conditions not established",
		input: "Checked input interval (kbps)",
		floor: "Calculated lower-limit interval (kbps)",
		calibration: "Recommended complexity boundaries (kbps)",
		calibrationHint:
			"The tool maps each row's minimum and maximum to the calculated floor F and overall maximum U. F is the upper end of the calculated lower-limit interval. These boundaries are recalculated from your requirements; they are tool recommendations, not provider defaults.",
		mixedCalibrationHint: (minimum: string, step: string, lower: string) =>
			`With automatic resolution generation disabled and explicit candidates above one highest fixed row, the shared lower boundary uses that fixed minimum × minimum step: ${minimum} × ${step} = ${lower} kbps, truncated to whole bps. The upper boundary is the overall maximum. This is a calibration recommendation, not the additional-rendition factor or an API default.`,
		minimumStep: "Minimum ratio",
		maximumStep: "Maximum ratio",
		minimumBound: "Local minimum-ratio check (excluded boundary)",
		maximumBound: "Local minimum-ratio check (included upper boundary)",
		segments: "Checked interval segments",
		spacingHint:
			"The minimum ratio is selected above the bound that prevents multiple points in each effective row interval, including integer rounding and the model's safety margin, and at or below the bound that connects adjacent rows. The maximum ratio covers those connections. Changing the minimum ratio requires another check: the effective intervals and lower limit are recalculated. Displayed bounds are approximate.",
		forcedCount: "Additional-rendition count",
		forcedFactor: "Additional-rendition factor",
		forcedMode: "Additional-rendition calculation",
		maximumFactor: "Calculated factor upper bound",
		forcedRanges: "Additional-rendition intervals (kbps)",
		forcedHint:
			"With no automatic templates and an exact count N, N minus the required rows reserves the additional slots. For LAST_CALCULATED_BITRATE, repeated integer rounding from the highest row's maximum determines the factor limit that stays within U. Compatible saved factors within the limit are kept; the limit is proposed when adjustment is needed. Locked values are kept, with conflicts reported. Ordinary minimum and maximum bitrate steps do not apply to additional renditions. Their count and cap are checked separately; this targets count and cap, not optimal quality.",
		conditional:
			"Automatic templates or unresolved branches make this a conditional calculation. The additional-rendition values are not an output-count guarantee.",
		conditions:
			"The check assumes the stated row order. Source analysis, equal-resolution probe ordering and actual encoded outputs remain unverified. It does not establish optimal quality or provider output.",
		changes: "Parameter changes",
		parameter: "Parameter",
		before: "Before",
		after: "After",
		unset: "Not set",
		removed: "Removed",
		undetermined: "Not established",
		checkpoints: "Effective ranges at checkpoints",
		checkpointInput: "Input (kbps)",
		row: "Required row",
		range: "Effective interval (kbps)",
		modes: {
			LAST_CALCULATED_BITRATE: "Last calculated bitrate",
			MINIMUM: "Minimum bitrate",
			MAXIMUM: "Maximum bitrate",
			AVERAGE: "Average bitrate",
		},
	},
	ja: {
		title: "パラメータの導出",
		checked: "区間・本数の条件を確認",
		checkedConditional: "素材の条件を前提に設定を確認",
		unknown: "組み合わせた条件は未確認",
		input: "確認する入力の範囲 (kbps)",
		floor: "計算に使う下限の範囲 (kbps)",
		calibration: "推奨する複雑度境界 (kbps)",
		calibrationHint:
			"各行の最小値・最大値を、計算した下限Fと全体の上限Uにそれぞれ対応させます。Fは、計算に使う下限範囲の上端です。境界は要件から計算し直します。ツールが提案する値で、APIの既定値ではありません。",
		mixedCalibrationHint: (minimum: string, step: string, lower: string) =>
			`解像度の自動生成を使わず、最高固定段が1つで、その上に明示した候補がある場合、下側境界は「最高固定段の最小値 × 最小間隔」で求めます（${minimum} × ${step} = ${lower} kbps、1 bps未満切り捨て）。上側境界は全体上限です。追加段の倍率とは別の提案方法で、APIの既定値ではありません。`,
		minimumStep: "最小比率",
		maximumStep: "最大比率",
		minimumBound: "選んだ設定での最小比率の下側境界（含まない）",
		maximumBound: "選んだ設定での最小比率の上側境界（含む）",
		segments: "確認した区間の数",
		spacingHint:
			"各有効範囲に2点以上入らない下限（整数への丸めとモデルの安全余裕を含む）より大きく、隣接段をつなげる上限以下の最小比率を選びます。最大比率はその接続を覆う値です。有効範囲と計算に使う下限も設定に依存するため、最小比率を変えたら再計算が必要です。表示した境界は概数です。",
		forcedCount: "追加レンディション数",
		forcedFactor: "追加レンディションの倍率",
		forcedMode: "追加レンディションの計算方法",
		maximumFactor: "計算上の倍率の上限",
		forcedRanges: "追加レンディションの範囲 (kbps)",
		forcedHint:
			"自動テンプレートがなく総本数をN本ちょうどに指定した場合は、Nから必須行数を引いた数を追加枠にします。LAST_CALCULATED_BITRATEでの上限確認では、最上段の最大値から倍率の適用と整数への四捨五入を繰り返し、Uを超えない倍率の上限を求めます。条件に合う上限内の既存倍率は維持し、調整が必要な場合に上限を提案します。固定した値は維持し、条件が合わなければ診断を示します。実際の追加段は、最後に算出したビットレートが基準です。通常の最小・最大ビットレート間隔は追加段には適用しません。本数と上限を別に確認する計算で、画質の最適化ではありません。",
		conditional:
			"自動テンプレートや未確定の分岐を含む条件付きの計算です。追加レンディションの設定値は、出力本数を保証しません。",
		conditions:
			"確認した行順を前提にした計算です。素材解析、同じ解像度の解析順、実際のエンコード結果は未確認です。画質の最適値やAPIの出力を保証するものではありません。",
		changes: "パラメータの変更",
		parameter: "項目",
		before: "変更前",
		after: "変更後",
		unset: "未設定",
		removed: "削除",
		undetermined: "未確定",
		checkpoints: "確認点ごとの有効範囲",
		checkpointInput: "入力 (kbps)",
		row: "必須の行",
		range: "有効範囲 (kbps)",
		modes: {
			LAST_CALCULATED_BITRATE: "最後に算出したビットレート",
			MINIMUM: "最小ビットレート",
			MAXIMUM: "最大ビットレート",
			AVERAGE: "平均ビットレート",
		},
	},
};

export function PerTitleSourceConditions({
	proposal,
}: {
	proposal: PerTitleProposal;
}) {
	const { locale } = useT();
	const report = proposal.derivation?.constraints;
	const model = report?.conditionalModel;
	if (
		!report ||
		!model ||
		report.status !== "checked" ||
		report.scope !== "conditional" ||
		proposal.status !== "candidate" ||
		!proposal.applicable
	)
		return null;
	const conditions = model.sourceConditions;
	const format = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
			value / 1000,
		);
	const interval = `${format(conditions.lowerProbe.minimum)}–${format(conditions.lowerProbe.maximum)} kbps`;
	const sourceDimension = new Intl.NumberFormat(locale).format(
		conditions.geometry.minimumSourceDimension,
	);
	const groups = conditions.fixedProbeOrder.equalDimensionGroups.map((group) =>
		group
			.map((rowId) => model.fixedRowIds.indexOf(rowId) + 1)
			.join(locale === "ja" ? "・" : " / "),
	);
	const copy =
		locale === "ja"
			? {
					title: "素材で未確認の条件",
					lower: `このモデルは、最下位の自動候補を解析し、複雑度で補正した値が ${interval} に収まる前提です。素材では未測定で、出力のビットレート制限ではありません。`,
					geometry: `素材の${conditions.geometry.basis === "height" ? "高さ" : "幅"}は ${sourceDimension} px 以上が必要です。${conditions.geometry.commonSourceAspectRatio ? "各段が同じ素材の縦横比を持つ前提です。" : ""}素材の寸法と実際の解像度の順序は未測定です。`,
					rounding:
						"丸め後の幅も、指定した解像度の順序と同じ解像度の組を保つ前提です。素材では未確認です。",
					order: groups.length
						? `同じ解像度の段（${groups.join("、")}）の実際の解析順は未確認です。`
						: "固定段の素材解析後の順序は未確認です。",
					count:
						"実際の出力本数と画質は、素材をエンコードして確認してください。",
				}
			: {
					title: "Unmeasured source conditions",
					lower: `The starting template's analyzed bitrate, after complexity scaling, must be within ${interval} for this model. It has not been measured; this is not an output bitrate limit.`,
					geometry: `This model needs a source ${conditions.geometry.basis} of at least ${sourceDimension} px. ${conditions.geometry.commonSourceAspectRatio ? "A common source aspect ratio is assumed. " : ""}Source dimensions and the resulting resolution order have not been measured.`,
					rounding:
						"Rounded widths must preserve the requested resolution order and groups at the same resolution; this has not been verified.",
					order: groups.length
						? `Required rows with the same resolution (${groups.join("; ")}) have an unmeasured analysis order.`
						: "The required rows' analysis order has not been measured.",
					count:
						"Encode your source to confirm the actual output count and quality.",
				};
	return (
		<section
			aria-label={copy.title}
			className="space-y-2 text-xs text-zinc-400"
		>
			<p className="font-medium text-zinc-300">{copy.title}</p>
			<ul className="list-disc space-y-1 pl-4">
				<li>{copy.lower}</li>
				<li>
					{copy.geometry}{" "}
					{conditions.geometry.postRoundingWidthOrderPreserved.status ===
					"not-measured"
						? copy.rounding
						: null}
				</li>
				<li>{copy.order}</li>
			</ul>
			<p>{copy.count}</p>
		</section>
	);
}

export function PerTitleConstraints({
	proposal,
}: {
	proposal: PerTitleProposal;
}) {
	const { locale } = useT();
	const report = proposal.derivation?.constraints;
	if (!report) return null;
	const copy = texts[locale];
	const calibrationOrigin = report.calibration?.origin;
	const finite = (value: number | null | undefined): value is number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0;
	const number = (value: number | null | undefined) =>
		finite(value)
			? new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(
					value,
				)
			: copy.undetermined;
	const ratio = (value: number | null | undefined) =>
		finite(value) && value > 0 ? `≈ ${number(value)}` : copy.undetermined;
	const range = (value: { minimum: number; maximum: number } | null) =>
		value &&
		finite(value.minimum) &&
		value.minimum > 0 &&
		finite(value.maximum) &&
		value.maximum >= value.minimum
			? `${number(value.minimum / 1000)}–${number(value.maximum / 1000)}`
			: copy.undetermined;
	const mode = (value: string | undefined) =>
		value && Object.hasOwn(copy.modes, value)
			? copy.modes[value as keyof typeof copy.modes]
			: copy.undetermined;
	const labels = {
		minimumStep: copy.minimumStep,
		maximumStep: copy.maximumStep,
		forcedCount: copy.forcedCount,
		forcedFactor: copy.forcedFactor,
		forcedMode: copy.forcedMode,
	};
	const changeValue = (
		field: keyof typeof labels,
		value: number | string | undefined,
		removed = false,
	) =>
		value === undefined
			? removed
				? copy.removed
				: copy.unset
			: typeof value === "string"
				? mode(value)
				: field === "forcedCount"
					? number(value)
					: ratio(value);
	const rows = [
		[copy.input, range(report.inputRange)],
		[copy.floor, range(report.floorRange)],
		...(report.calibration
			? [
					[
						copy.calibration,
						range({
							minimum: report.calibration.low,
							maximum: report.calibration.high,
						}),
					],
				]
			: []),
		[copy.minimumStep, ratio(proposal.derivation?.selectedMinStep)],
		[copy.maximumStep, ratio(proposal.derivation?.selectedMaxStep)],
		...(report.spacing
			? [
					[copy.minimumBound, ratio(report.spacing.minimumExclusive)],
					...(report.spacing.maximumInclusive !== null
						? [[copy.maximumBound, ratio(report.spacing.maximumInclusive)]]
						: []),
					[copy.segments, number(report.spacing.checkedSegments)],
				]
			: []),
		[copy.forcedCount, number(report.forced.count)],
		[copy.forcedFactor, ratio(report.forced.factor)],
		[copy.forcedMode, mode(report.forced.calculationMode)],
		...(report.forced.maximumFactor !== undefined
			? [[copy.maximumFactor, ratio(report.forced.maximumFactor)]]
			: []),
		...(report.forced.ranges.length
			? [[copy.forcedRanges, report.forced.ranges.map(range).join("; ")]]
			: []),
	];
	const heights = new Map(
		proposal.api.streams.map((row) => [row.rowId, row.height]),
	);
	const checked =
		report.status === "checked" &&
		proposal.status === "candidate" &&
		proposal.applicable &&
		proposal.derivation?.targetSatisfied === true;
	return (
		<details className="space-y-3 border-t border-zinc-800 pt-4 text-xs text-zinc-400">
			<summary className="cursor-pointer">{copy.title}</summary>
			<p className="text-zinc-300">
				{checked
					? report.conditionalModel
						? copy.checkedConditional
						: copy.checked
					: copy.unknown}
			</p>
			<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-md bg-zinc-900 p-3">
				{rows.map(([label, value]) => (
					<div key={label} className="contents">
						<dt>{label}</dt>
						<dd className="break-words text-zinc-200">{value}</dd>
					</div>
				))}
			</dl>
			{report.calibration ? (
				<p>
					{calibrationOrigin?.kind === "fixed-minimum-step"
						? copy.mixedCalibrationHint(
								number(calibrationOrigin.minimumBitrate / 1000),
								number(calibrationOrigin.minimumStep),
								number(report.calibration.low / 1000),
							)
						: copy.calibrationHint}
				</p>
			) : null}
			{report.spacing ? <p>{copy.spacingHint}</p> : null}
			<p>{copy.forcedHint}</p>
			{report.scope === "conditional" || report.forced.conditional ? (
				<p>{copy.conditional}</p>
			) : null}
			{report.changes.length ? (
				<div className="overflow-x-auto">
					<table aria-label={copy.changes} className="w-full text-left">
						<thead>
							<tr>
								<th scope="col">{copy.parameter}</th>
								<th scope="col">{copy.before}</th>
								<th scope="col">{copy.after}</th>
							</tr>
						</thead>
						<tbody>
							{report.changes.map((change) => (
								<tr key={change.field} className="border-t border-zinc-800">
									<th scope="row" className="py-1 font-normal">
										{labels[change.field]}
									</th>
									<td>{changeValue(change.field, change.before)}</td>
									<td>{changeValue(change.field, change.after, true)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			{report.checkpoints.length ? (
				<div className="overflow-x-auto">
					<table aria-label={copy.checkpoints} className="w-full text-left">
						<thead>
							<tr>
								<th scope="col">{copy.checkpointInput}</th>
								<th scope="col">{copy.row}</th>
								<th scope="col">{copy.range}</th>
							</tr>
						</thead>
						<tbody>
							{report.checkpoints.flatMap((point, pointIndex) =>
								point.rows.map((row, index) => (
									<tr
										key={`${pointIndex}-${row.rowId}`}
										className="border-t border-zinc-800"
									>
										<td className="py-1">
											{finite(point.input)
												? number(point.input / 1000)
												: copy.undetermined}
										</td>
										<th scope="row" className="font-normal">
											{index + 1}
											{finite(heights.get(row.rowId))
												? ` (${number(heights.get(row.rowId))} px)`
												: ""}
										</th>
										<td>{range(row)}</td>
									</tr>
								)),
							)}
						</tbody>
					</table>
				</div>
			) : null}
			<p>{copy.conditions}</p>
			<PerTitleSourceConditions proposal={proposal} />
		</details>
	);
}
