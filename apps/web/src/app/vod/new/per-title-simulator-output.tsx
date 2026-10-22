"use client";

import { type PerTitleProposal, previewPerTitleOutput } from "@bitovp/core";
import { useId } from "react";
import { useT } from "@/lib/i18n/context";
import {
	type PerTitleChartAxis,
	perTitlePlotAxis,
} from "./per-title-simulator-ladder";

const copy = {
	en: {
		title: "Simulated output",
		data: "Simulated output (data)",
		axis: "kbps (log scale)",
		input: (rate: string) => `Upper input assumed at ${rate} kbps`,
		inputUnknown: "Upper input unavailable",
		candidate: "Candidate",
		automatic: "Automatic candidate",
		additional: "Additional",
		start: "Start",
		forced: "Additional (if fixed is highest)",
		heightUnknown: "Resolution unknown",
		example: "Example",
		conditional: "Conditional",
		unknown: "Unknown",
		target: (rate: string) => `Upper target ${rate}`,
		unresolved: "Additional outputs unknown",
		unavailable: "Output unavailable",
		overflow: "Outside scale",
		rendition: "Rendition",
		mode: "Mode",
		bitrate: "Bitrate (kbps)",
		description:
			"Explicit-template example; source analysis may change resolutions. Extra output assumes a fixed rendition is highest.",
	},
	ja: {
		title: "想定出力",
		data: "想定出力（データ）",
		axis: "kbps（対数目盛）",
		input: (rate: string) => `解析値を ${rate} kbps と仮定`,
		inputUnknown: "解析値の上限は未確定",
		candidate: "候補",
		automatic: "自動生成の候補",
		additional: "追加",
		start: "開始",
		forced: "固定レンディションが最上位の場合に追加",
		heightUnknown: "解像度未確定",
		example: "計算例",
		conditional: "条件付き",
		unknown: "未確定",
		target: (rate: string) => `上限の目安 ${rate}`,
		unresolved: "追加出力は未確定",
		unavailable: "想定出力を表示できません",
		overflow: "目盛りの範囲外",
		rendition: "レンディション",
		mode: "モード",
		bitrate: "ビットレート (kbps)",
		description:
			"指定したテンプレートの計算例です。素材解析で解像度が変わる場合があります。追加値は固定レンディションが最上位の場合を仮定します。",
	},
};

const positiveInteger = (value: number | undefined | null): value is number =>
	value !== undefined &&
	value !== null &&
	Number.isSafeInteger(value) &&
	value > 0;

export function PerTitleOutputChart({
	proposal,
	axis,
}: {
	proposal: PerTitleProposal;
	axis?: PerTitleChartAxis;
}) {
	const { locale } = useT();
	const text = copy[locale];
	const id = useId();
	const preview = previewPerTitleOutput(proposal);
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
	const rows = preview.rows
		.map((row, index) => {
			const numeric = row.status !== "unknown";
			const target =
				numeric && positiveInteger(row.bitrate) ? row.bitrate : undefined;
			const range =
				numeric &&
				positiveInteger(row.minimumBitrate) &&
				positiveInteger(row.maximumBitrate) &&
				row.minimumBitrate <= row.maximumBitrate
					? { minimum: row.minimumBitrate, maximum: row.maximumBitrate }
					: undefined;
			const automatic =
				row.kind === "automatic" || row.mode === "PER_TITLE_TEMPLATE";
			const label = automatic
				? positiveInteger(row.height)
					? `${text.candidate} ${row.height} px`
					: text.automatic
				: positiveInteger(row.height)
					? `${row.height} px`
					: text.heightUnknown;
			const status =
				target === undefined && range === undefined
					? text.unknown
					: row.status === "conditional"
						? text.conditional
						: text.example;
			const values = range
				? range.minimum === range.maximum
					? bitrate(range.minimum)
					: `${bitrate(range.minimum)}–${bitrate(range.maximum)}`
				: target !== undefined
					? bitrate(target)
					: "";
			const basis =
				target === undefined
					? undefined
					: row.basis === "minimum"
						? text.start
						: row.basis === "forced"
							? text.forced
							: undefined;
			return {
				row,
				index,
				target,
				range,
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
	return (
		<figure aria-labelledby={`${id}-title`} className="space-y-2">
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
				<span id={`${id}-title`} className="font-medium text-zinc-200">
					{text.title}
				</span>
				<span className="text-zinc-400">
					{positiveInteger(preview.analysisInput)
						? text.input(bitrate(preview.analysisInput))
						: text.inputUnknown}
				</span>
			</figcaption>
			{scale && rows.length ? (
				<>
					<div
						role="img"
						aria-labelledby={`${id}-title`}
						aria-describedby={`${id}-axis ${id}-description`}
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
								label,
								status,
								values,
								automatic,
								basis,
							}) => {
								const band =
									range ?? (target === undefined ? permitted : undefined);
								const lower = band?.minimum ?? target;
								const upper = band?.maximum ?? target;
								const below = lower !== undefined && lower < scale.minimum;
								const above = upper !== undefined && upper > scale.maximum;
								const conditional = row.status === "conditional";
								return (
									<div
										key={`${row.id}-${index}`}
										data-testid="per-title-output-row"
										className="grid grid-cols-[6rem_minmax(0,1fr)] items-end gap-x-2 text-xs"
									>
										<span className="pb-1 text-zinc-300 tabular-nums">
											{label}
										</span>
										<div className="min-w-0">
											<div className="flex flex-wrap justify-end gap-x-2 text-zinc-300 tabular-nums">
												{automatic ? (
													<code className="text-zinc-400">
														PER_TITLE_TEMPLATE
													</code>
												) : null}
												{basis || row.kind === "additional" ? (
													<span className="text-zinc-400">
														{basis ?? text.additional}
													</span>
												) : null}
												{values ? <span>{values}</span> : null}
												<span className="text-zinc-400">{status}</span>
												{conditional &&
												range &&
												range.minimum !== range.maximum &&
												target !== undefined ? (
													<span className="text-zinc-400">
														{text.target(bitrate(target))}
													</span>
												) : null}
												{below || above ? (
													<span className="text-amber-300">
														{below ? "← " : ""}
														{text.overflow}
														{above ? " →" : ""}
													</span>
												) : null}
											</div>
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
												{band ? (
													<line
														data-testid="per-title-output-band"
														x1={scale.position(band.minimum)}
														x2={scale.position(band.maximum)}
														y1={6}
														y2={6}
														className="stroke-zinc-400"
														strokeWidth={2}
														strokeDasharray="4 3"
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
					<table aria-label={text.data} className="sr-only">
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
									range,
									target,
									basis,
								}) => (
									<tr key={`${row.id}-${index}`}>
										<th scope="row">{label}</th>
										<td>
											{row.mode ??
												(row.kind === "additional" ? text.additional : "")}
										</td>
										<td>
											{values} {status} {basis}
											{row.status === "conditional" &&
											range &&
											target !== undefined
												? ` ${text.target(bitrate(target))}`
												: ""}
										</td>
									</tr>
								),
							)}
						</tbody>
					</table>
				</>
			) : (
				<p className="text-xs text-zinc-400">{text.unavailable}</p>
			)}
			{preview.unresolvedAdditional && !forcedOutput ? (
				<p className="text-xs text-zinc-400">{text.unresolved}</p>
			) : null}
		</figure>
	);
}
