"use client";

import {
	type PerTitleGoal,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";
import { useId } from "react";
import { useT } from "@/lib/i18n/context";
import {
	type PerTitleChartAxis,
	perTitlePlotAxis,
} from "./per-title-simulator-ladder";
import { perTitleStreamLabel } from "./per-title-stream-mode";

const copy = {
	en: {
		title: "Simulated output",
		data: "Simulated output (data)",
		axis: "kbps (log scale)",
		input: (rate: string) => `Upper input assumed at ${rate} kbps`,
		cappedInput: (rate: string, requested: string) =>
			`Capped top: ${rate} kbps (assumed ${requested})`,
		inputUnknown: "Upper input unavailable",
		candidates: (heights: string) => `${heights} px`,
		automatic: "Resolution not specified",
		automaticGroup: "PER_TITLE_TEMPLATE (content analysis)",
		automaticHint: "Count and resolutions are determined by content analysis.",
		countSlot: (ordinal: number) => `Rendition ${ordinal}`,
		countExact: (count: number) =>
			`Bitrate ranges for ${count} requested renditions`,
		countMaximum: (count: number) =>
			`At most ${count} renditions; count unresolved`,
		countInfeasible:
			"The requested count does not fit these bitrate intervals and spacing.",
		countUnavailable:
			"A count-specific model is unavailable for these settings.",
		countLimit: "Count-specific display supports up to 256 renditions.",
		spacing: (minimum: string, maximum: string) =>
			`Spacing interval ${minimum === maximum ? minimum : `${minimum}–${maximum}`}`,
		assumedRange: (minimum: string, maximum: string) =>
			`Assumed range ${minimum === maximum ? minimum : `${minimum}–${maximum}`}`,
		additional: "Additional",
		start: "Start",
		forced: "Additional (if fixed is highest)",
		analysis: "Analysis assumption (count unresolved)",
		assumed: (rate: string) => `Assumed ${rate}`,
		forcedFallback: (range: string, count: number, factor: string) =>
			`If fixed is highest: ${range} kbps (${count} ${count === 1 ? "step" : "steps"}, ×${factor} each). This factor does not cap normal upper outputs.`,
		heightUnknown: "Resolution unknown",
		example: "Example",
		conditional: "Conditional",
		unknown: "Unknown",
		configured: (minimum: string, maximum: string) =>
			`Configured ${minimum === maximum ? minimum : `${minimum}–${maximum}`}`,
		point: (rate: string) => `Calculated point ${rate}`,
		effective: (minimum: string, maximum: string) =>
			minimum === maximum
				? `Effective value ${minimum}`
				: `Effective interval ${minimum}–${maximum}`,
		floorApplied: (input: string, complexity: string) =>
			`Complexity input ${input} → ${complexity} kbps (fixed-rendition floor).`,
		overallFloorApplied: (input: string, complexity: string) =>
			`Complexity input ${input} → ${complexity} kbps (overall minimum).`,
		floorUnknown:
			"The fixed-rendition floor is unresolved; complexity targets are unavailable.",
		aspectAssumption: "Height-only templates assume a shared aspect ratio.",
		target: (rate: string) => `Upper target ${rate}`,
		unresolved: "Additional outputs unknown",
		unavailable: "Output unavailable",
		exceedsGlobal: (value: string, maximum: string) =>
			`Additional value ${value} kbps exceeds the overall maximum of ${maximum} kbps. Lower the additional factor or fixed-rendition maximum.`,
		overflow: "Outside scale",
		rendition: "Rendition",
		mode: "Mode",
		bitrate: "Bitrate (kbps)",
		description:
			"Parameter-derived intervals and conditional calculation points; source analysis may change resolutions. Extra output assumes a fixed rendition is highest.",
	},
	ja: {
		title: "想定出力",
		data: "想定出力（データ）",
		axis: "kbps（対数目盛）",
		input: (rate: string) => `解析値を ${rate} kbps と仮定`,
		cappedInput: (rate: string, requested: string) =>
			`上限適用後 ${rate} kbps（仮定値 ${requested}）`,
		inputUnknown: "解析値の上限は未確定",
		candidates: (heights: string) => `${heights} px`,
		automatic: "解像度未指定",
		automaticGroup: "PER_TITLE_TEMPLATE（素材解析で決定）",
		automaticHint: "本数と解像度は素材解析で決まります。",
		countSlot: (ordinal: number) => `${ordinal}段目`,
		countExact: (count: number) => `指定${count}本のビットレート範囲`,
		countMaximum: (count: number) => `最大${count}本（本数未確定）`,
		countInfeasible:
			"このビットレート範囲と間隔では、指定本数を配置できません。",
		countUnavailable: "この設定では、本数別の範囲を計算できません。",
		countLimit: "本数別の表示は256本まで対応しています。",
		spacing: (minimum: string, maximum: string) =>
			`間隔からの範囲 ${minimum === maximum ? minimum : `${minimum}–${maximum}`}`,
		assumedRange: (minimum: string, maximum: string) =>
			`仮定の範囲 ${minimum === maximum ? minimum : `${minimum}–${maximum}`}`,
		additional: "追加",
		start: "開始",
		forced: "固定レンディションが最上位の場合に追加",
		analysis: "解析値の仮定（本数未確定）",
		assumed: (rate: string) => `仮定 ${rate}`,
		forcedFallback: (range: string, count: number, factor: string) =>
			`固定段が最上位なら ${range} kbps（${count}段・各段×${factor}）。通常上段の上限ではありません。`,
		heightUnknown: "解像度未確定",
		example: "計算例",
		conditional: "条件付き",
		unknown: "未確定",
		configured: (minimum: string, maximum: string) =>
			`設定範囲 ${minimum === maximum ? minimum : `${minimum}–${maximum}`}`,
		point: (rate: string) => `計算点 ${rate}`,
		effective: (minimum: string, maximum: string) =>
			minimum === maximum
				? `有効値 ${minimum}`
				: `有効範囲 ${minimum}–${maximum}`,
		floorApplied: (input: string, complexity: string) =>
			`複雑度の計算値 ${input} → ${complexity} kbps（固定段の下限を適用）。`,
		overallFloorApplied: (input: string, complexity: string) =>
			`複雑度の計算値 ${input} → ${complexity} kbps（全体の下限を適用）。`,
		floorUnknown: "固定段の下限が未確定のため、複雑度に応じた値は未確定です。",
		aspectAssumption:
			"高さのみを指定したテンプレートは、共通のアスペクト比を仮定しています。",
		target: (rate: string) => `上限の目安 ${rate}`,
		unresolved: "追加出力は未確定",
		unavailable: "想定出力を表示できません",
		exceedsGlobal: (value: string, maximum: string) =>
			`追加値 ${value} kbps が全体上限 ${maximum} kbps を超えます。追加倍率か固定段の上限を下げてください。`,
		overflow: "目盛りの範囲外",
		rendition: "レンディション",
		mode: "モード",
		bitrate: "ビットレート (kbps)",
		description:
			"設定から導いた範囲と条件付きの計算点です。素材解析で解像度が変わる場合があります。追加値は固定レンディションが最上位の場合を仮定します。",
	},
};

const positiveInteger = (value: number | undefined | null): value is number =>
	value !== undefined &&
	value !== null &&
	Number.isSafeInteger(value) &&
	value > 0;

export function PerTitleOutputChart({
	proposal,
	countPolicy,
	axis,
	analysisInput,
	title,
}: {
	proposal: PerTitleProposal;
	countPolicy?: PerTitleGoal["countPolicy"];
	axis?: PerTitleChartAxis;
	analysisInput?: number;
	title?: string;
}) {
	const { locale } = useT();
	const text = copy[locale];
	const dataTitle =
		title === undefined
			? text.data
			: locale === "ja"
				? `${title}（データ）`
				: `${title} (data)`;
	const id = useId();
	const preview =
		analysisInput === undefined && countPolicy === undefined
			? previewPerTitleOutput(proposal)
			: previewPerTitleOutput(proposal, {
					...(analysisInput === undefined ? {} : { analysisInput }),
					...(countPolicy === undefined ? {} : { countPolicy }),
				});
	const global = proposal.api.global;
	const permitted =
		positiveInteger(global.minBitrate) &&
		positiveInteger(global.maxBitrate) &&
		global.minBitrate <= global.maxBitrate
			? { minimum: global.minBitrate, maximum: global.maxBitrate }
			: undefined;
	const scale = perTitlePlotAxis(
		axis ?? {
			minimum: global.minBitrate,
			maximum: global.maxBitrate,
		},
	);
	const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	const tickNumbers = new Intl.NumberFormat(locale, {
		maximumSignificantDigits: 3,
	});
	const bitrate = (value: number) => numbers.format(value / 1000);
	// Match the resolver's branch even when a fixed-template floor is below the global minimum.
	const usesFixedBitrateFloor = proposal.api.streams.some(
		(stream) =>
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	const floorNote =
		positiveInteger(preview.analysisInput) &&
		positiveInteger(preview.complexityInput) &&
		preview.complexityInput > preview.analysisInput
			? (usesFixedBitrateFloor ? text.floorApplied : text.overallFloorApplied)(
					bitrate(preview.analysisInput),
					bitrate(preview.complexityInput),
				)
			: undefined;
	const floorUnknown =
		preview.floor === null &&
		proposal.api.streams.some(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
				stream.perTitleSettings?.bitrateSelectionMode === "COMPLEXITY_RANGE",
		);
	const automaticGroup = preview.rows.some(
		(row) => row.kind === "automatic-group",
	);
	const countProjection = preview.countProjection;
	const countLabel =
		countProjection && positiveInteger(countProjection.requestedCount)
			? countProjection.kind === "maximum"
				? text.countMaximum(countProjection.requestedCount)
				: text.countExact(countProjection.requestedCount)
			: undefined;
	const countProblem =
		countProjection?.status === "infeasible"
			? text.countInfeasible
			: countProjection?.status === "unavailable" &&
					countProjection.reason !== "maximum-only"
				? countProjection.reason === "model-limit"
					? text.countLimit
					: text.countUnavailable
				: undefined;
	const rows = preview.rows
		.map((row, index) => {
			const matches = proposal.api.streams.filter(
				(stream) => stream.rowId === row.rowId,
			);
			const stream = matches.length === 1 ? matches[0] : undefined;
			const settings = stream?.perTitleSettings;
			const configured =
				row.kind === "fixed" &&
				stream?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
				positiveInteger(settings?.minBitrate) &&
				positiveInteger(settings.maxBitrate) &&
				settings.minBitrate <= settings.maxBitrate
					? { minimum: settings.minBitrate, maximum: settings.maxBitrate }
					: undefined;
			const numeric = row.status !== "unknown";
			const target =
				row.kind !== "automatic-group" &&
				numeric &&
				positiveInteger(row.bitrate)
					? row.bitrate
					: undefined;
			const range =
				(numeric || row.rangeBasis === "configured") &&
				positiveInteger(row.minimumBitrate) &&
				positiveInteger(row.maximumBitrate) &&
				row.minimumBitrate <= row.maximumBitrate
					? { minimum: row.minimumBitrate, maximum: row.maximumBitrate }
					: undefined;
			const automatic =
				row.kind === "automatic" || row.mode === "PER_TITLE_TEMPLATE";
			const candidateHeights = [
				...new Set(
					(row.candidateRowIds ?? []).flatMap((rowId) => {
						const stream = proposal.api.streams.find(
							(item) =>
								item.rowId === rowId && item.mode === "PER_TITLE_TEMPLATE",
						);
						return positiveInteger(stream?.height) ? [stream.height] : [];
					}),
				),
			];
			const dimension = positiveInteger(row.height)
				? `${row.height} px`
				: positiveInteger(row.width)
					? `${locale === "ja" ? "幅" : "Width"} ${row.width} px`
					: undefined;
			const label =
				row.kind === "count-slot" && positiveInteger(row.ordinal)
					? text.countSlot(row.ordinal)
					: row.kind === "automatic-group"
						? text.automaticGroup
						: row.basis === "analysis" && candidateHeights.length
							? text.candidates(
									candidateHeights
										.map((height) => numbers.format(height))
										.join(" / "),
								)
							: automatic
								? (dimension ?? text.automatic)
								: (dimension ?? text.heightUnknown);
			const status =
				row.status === "unknown" ||
				(target === undefined && range === undefined)
					? text.unknown
					: row.status === "conditional"
						? text.conditional
						: text.example;
			const value = range
				? row.rangeBasis === "effective"
					? text.effective(bitrate(range.minimum), bitrate(range.maximum))
					: row.rangeBasis === "configured"
						? text.configured(bitrate(range.minimum), bitrate(range.maximum))
						: row.rangeBasis === "assumed"
							? text.assumedRange(
									bitrate(range.minimum),
									bitrate(range.maximum),
								)
							: row.rangeBasis === "spacing"
								? text.spacing(bitrate(range.minimum), bitrate(range.maximum))
								: range.minimum === range.maximum
									? bitrate(range.minimum)
									: `${bitrate(range.minimum)}–${bitrate(range.maximum)}`
				: configured
					? text.configured(
							bitrate(configured.minimum),
							bitrate(configured.maximum),
						)
					: target !== undefined
						? bitrate(target)
						: "";
			const values =
				row.basis === "analysis" && row.rangeBasis !== "assumed" && value
					? text.assumed(value)
					: value;
			const targetText =
				target === undefined
					? undefined
					: configured || row.rangeBasis === "effective"
						? text.point(bitrate(target))
						: row.status === "conditional" &&
								range &&
								range.minimum !== range.maximum
							? text.target(bitrate(target))
							: undefined;
			const configuredText =
				configured && range && row.rangeBasis !== "configured"
					? text.configured(
							bitrate(configured.minimum),
							bitrate(configured.maximum),
						)
					: undefined;
			const basis =
				target === undefined && range === undefined
					? undefined
					: row.basis === "minimum"
						? text.start
						: row.basis === "forced"
							? text.forced
							: row.basis === "analysis"
								? text.analysis
								: undefined;
			return {
				row,
				index,
				target,
				range,
				configured,
				targetText,
				configuredText,
				label,
				status,
				values,
				automatic,
				basis,
			};
		})
		.sort(
			(a, b) =>
				(positiveInteger(a.row.height)
					? a.row.height
					: Number.POSITIVE_INFINITY) -
					(positiveInteger(b.row.height)
						? b.row.height
						: Number.POSITIVE_INFINITY) || a.index - b.index,
		);
	const forcedOutput = rows.some(
		({ row, target, range }) =>
			row.basis === "forced" && (target !== undefined || range !== undefined),
	);
	const forcedFallback = forcedOutput ? undefined : preview.forcedFallback;
	const forcedMaximum = Math.max(
		forcedFallback?.maximumBitrate ?? 0,
		...rows.map(({ row, target, range }) =>
			row.basis === "forced" ? Math.max(target ?? 0, range?.maximum ?? 0) : 0,
		),
	);
	const forcedOverflow =
		permitted && forcedMaximum > permitted.maximum ? forcedMaximum : undefined;
	return (
		<figure aria-labelledby={`${id}-title`} className="space-y-2">
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
				<span id={`${id}-title`} className="font-medium text-zinc-200">
					{title ?? text.title}
				</span>
				<span className="text-zinc-400">
					{positiveInteger(preview.analysisInput)
						? positiveInteger(preview.requestedAnalysisInput) &&
							preview.requestedAnalysisInput !== preview.analysisInput
							? text.cappedInput(
									bitrate(preview.analysisInput),
									bitrate(preview.requestedAnalysisInput),
								)
							: text.input(bitrate(preview.analysisInput))
						: text.inputUnknown}
				</span>
			</figcaption>
			{countLabel || countProblem ? (
				<div id={`${id}-count`} className="space-y-1 text-xs">
					{countLabel ? <p className="text-zinc-300">{countLabel}</p> : null}
					{countProblem ? (
						<p className="text-amber-300">{countProblem}</p>
					) : null}
				</div>
			) : null}
			{floorNote ? (
				<p id={`${id}-floor`} className="text-xs text-zinc-400">
					{floorNote}
				</p>
			) : floorUnknown ? (
				<p id={`${id}-floor`} className="text-xs text-zinc-400">
					{text.floorUnknown}
				</p>
			) : null}
			{preview.usesAspectRatioAssumption ? (
				<p id={`${id}-aspect`} className="text-xs text-zinc-400">
					{text.aspectAssumption}
				</p>
			) : null}
			{automaticGroup ? (
				<p id={`${id}-automatic`} className="text-xs text-zinc-400">
					{text.automaticHint}
				</p>
			) : null}
			{scale && rows.length ? (
				<>
					<div
						role="img"
						aria-labelledby={`${id}-title`}
						aria-describedby={`${id}-axis ${id}-description${forcedFallback ? ` ${id}-fallback` : ""}${floorNote || floorUnknown ? ` ${id}-floor` : ""}${preview.usesAspectRatioAssumption ? ` ${id}-aspect` : ""}${automaticGroup ? ` ${id}-automatic` : ""}${countLabel || countProblem ? ` ${id}-count` : ""}`}
						className="space-y-2"
					>
						<div
							data-testid="per-title-output-axis"
							className="ml-26 text-xs text-zinc-400"
						>
							<div id={`${id}-axis`} className="text-right">
								{text.axis}
							</div>
							<div className="relative h-6 border-b border-zinc-700">
								{scale.ticks.map((tick) => {
									const percent = scale.position(tick);
									return (
										<span
											key={tick}
											className={`absolute top-0 tabular-nums ${percent === 0 ? "" : percent === 100 ? "-translate-x-full" : "-translate-x-1/2"}`}
											style={{ left: `${percent}%` }}
										>
											{tickNumbers.format(tick / 1000)}
										</span>
									);
								})}
							</div>
						</div>
						{rows.map(
							({
								row,
								index,
								target,
								range,
								configured,
								targetText,
								configuredText,
								label,
								status,
								values,
								automatic,
								basis,
							}) => {
								const band =
									range ??
									configured ??
									(target === undefined ? permitted : undefined);
								const lower = band?.minimum ?? target;
								const upper = band?.maximum ?? target;
								const displayed = [
									lower,
									upper,
									target,
									configured?.minimum,
									configured?.maximum,
								].filter((value): value is number => value !== undefined);
								const below = displayed.some((value) => value < scale.minimum);
								const above = displayed.some((value) => value > scale.maximum);
								const conditional = row.status === "conditional";
								return (
									<div
										key={`${row.id}-${index}`}
										data-testid="per-title-output-row"
										className="grid grid-cols-[6rem_minmax(0,1fr)] items-end gap-x-2 text-xs"
									>
										<span className="min-w-0 break-all pb-1 text-zinc-300 tabular-nums">
											{label}
										</span>
										<div className="min-w-0">
											<div className="flex flex-wrap justify-end gap-x-2 text-zinc-300 tabular-nums">
												{row.mode || automatic ? (
													<code className="min-w-0 break-all text-[10px] text-zinc-400">
														{perTitleStreamLabel(
															{
																mode: row.mode ?? "PER_TITLE_TEMPLATE",
																height: row.height,
																width: row.width,
															},
															locale,
														)}
													</code>
												) : null}
												{basis || row.kind === "additional" ? (
													<span className="text-zinc-400">
														{basis ?? text.additional}
													</span>
												) : null}
												{values ? <span>{values}</span> : null}
												<span className="text-zinc-400">{status}</span>
												{targetText ? (
													<span className="text-zinc-400">{targetText}</span>
												) : null}
												{below || above ? (
													<span className="text-amber-300">
														{below ? "← " : ""}
														{text.overflow}
														{above ? " →" : ""}
													</span>
												) : null}
											</div>
											{configuredText ? (
												<p className="text-right text-zinc-500 tabular-nums">
													{configuredText}
												</p>
											) : null}
											<svg
												viewBox="0 0 100 12"
												preserveAspectRatio="none"
												aria-hidden="true"
												focusable="false"
												className="h-3 w-full overflow-visible"
											>
												<line
													x1={0}
													x2={100}
													y1={6}
													y2={6}
													className="stroke-zinc-800"
													strokeWidth={1}
													vectorEffect="non-scaling-stroke"
												/>
												{configured &&
												range &&
												row.rangeBasis !== "configured" ? (
													<line
														data-testid="per-title-output-configured-band"
														x1={scale.position(configured.minimum)}
														x2={scale.position(configured.maximum)}
														y1={6}
														y2={6}
														className="stroke-zinc-700"
														strokeWidth={6}
														vectorEffect="non-scaling-stroke"
													/>
												) : null}
												{band ? (
													<line
														data-testid="per-title-output-band"
														x1={scale.position(band.minimum)}
														x2={scale.position(band.maximum)}
														y1={6}
														y2={6}
														className="stroke-zinc-300"
														strokeWidth={3}
														strokeDasharray={
															band.minimum === band.maximum ? undefined : "4 3"
														}
														strokeLinecap="round"
														vectorEffect="non-scaling-stroke"
													/>
												) : null}
												{target !== undefined ? (
													<>
														<line
															data-testid="per-title-output-target"
															x1={0}
															x2={scale.position(target)}
															y1={6}
															y2={6}
															className={
																conditional
																	? "stroke-amber-300"
																	: "stroke-emerald-400"
															}
															strokeWidth={4}
															strokeDasharray={conditional ? "3 2" : undefined}
															vectorEffect="non-scaling-stroke"
														/>
														<line
															data-testid="per-title-output-endpoint"
															x1={scale.position(target)}
															x2={scale.position(target)}
															y1={2}
															y2={10}
															className={
																conditional
																	? "stroke-amber-300"
																	: "stroke-emerald-400"
															}
															strokeWidth={1}
															vectorEffect="non-scaling-stroke"
														/>
													</>
												) : null}
											</svg>
										</div>
									</div>
								);
							},
						)}
					</div>
					<p id={`${id}-description`} className="sr-only">
						{text.description}
					</p>
					<div className="sr-only">
						<table aria-label={dataTitle}>
							<thead>
								<tr>
									<th scope="col">{text.rendition}</th>
									<th scope="col">{text.mode}</th>
									<th scope="col">{text.bitrate}</th>
								</tr>
							</thead>
							<tbody>
								{rows.map(
									({
										row,
										index,
										label,
										status,
										values,
										targetText,
										configuredText,
										basis,
									}) => (
										<tr key={`${row.id}-${index}`}>
											<th scope="row">{label}</th>
											<td>
												{row.mode ??
													(row.kind === "count-slot"
														? "PER_TITLE_TEMPLATE"
														: row.kind === "additional"
															? text.additional
															: "")}
											</td>
											<td>
												{values} {status} {basis}
												{targetText ? ` ${targetText}` : ""}
												{configuredText ? ` ${configuredText}` : ""}
											</td>
										</tr>
									),
								)}
							</tbody>
						</table>
					</div>
				</>
			) : (
				<p className="text-xs text-zinc-400">{text.unavailable}</p>
			)}
			{forcedFallback ? (
				<p
					id={`${id}-fallback`}
					data-testid="per-title-forced-fallback"
					className="text-xs text-zinc-400"
				>
					{text.forcedFallback(
						forcedFallback.minimumBitrate === forcedFallback.maximumBitrate
							? bitrate(forcedFallback.minimumBitrate)
							: `${bitrate(forcedFallback.minimumBitrate)}–${bitrate(forcedFallback.maximumBitrate)}`,
						forcedFallback.count,
						String(forcedFallback.factor),
					)}
				</p>
			) : null}
			{forcedOverflow !== undefined && permitted ? (
				<p role="alert" className="text-amber-300 text-xs">
					{text.exceedsGlobal(
						bitrate(forcedOverflow),
						bitrate(permitted.maximum),
					)}
				</p>
			) : null}
			{preview.unresolvedAdditional ? (
				<p className="text-xs text-zinc-400">{text.unresolved}</p>
			) : null}
		</figure>
	);
}
