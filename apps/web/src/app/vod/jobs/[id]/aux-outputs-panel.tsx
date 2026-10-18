"use client";

import type { EncodingPlan } from "@bitovp/core";
import { DetailPopover, KeyValueRows } from "@/components/ui/detail-popover";
import { useT } from "@/lib/i18n/context";

/**
 *  item 6 (aux half): `plan.thumbnails`, `plan.sprites` and
 * `plan.keyframes` rendered NOWHERE on the job detail — the plan carried
 * full configurations and the page never mentioned them. Each row shows the
 * salient parameters inline and opens the FULL config in a DetailPopover
 * (the #80 pattern). Renders nothing when the plan has none of the three.
 */

function AuxRow({
	name,
	inline,
	label,
	record,
}: {
	name: string;
	inline: string;
	label: string;
	record: Record<string, unknown>;
}) {
	const { t } = useT();
	return (
		<li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
			<span className="select-all font-mono text-zinc-300">{name}</span>
			<span className="text-zinc-500">{inline}</span>
			<DetailPopover
				summary={
					<>
						{t("jobDetail.paramsCount", {
							count: Object.keys(record).length,
						})}
						{/* Three thumbnails give three identical "7 parameters"
						    triggers — suffix the row's key invisibly (review-179 N4,
						    the same fix the row expanders already carry). */}
						<span className="sr-only">{`, ${name}`}</span>
					</>
				}
				label={label}
			>
				<div className="max-w-96">
					<KeyValueRows record={record} />
				</div>
			</DetailPopover>
		</li>
	);
}

function Group({
	heading,
	children,
}: {
	heading: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<h3 className="mb-1 text-xs text-zinc-500">{heading}</h3>
			<ul className="space-y-1">{children}</ul>
		</div>
	);
}

export function AuxOutputsPanel({ plan }: { plan: EncodingPlan }) {
	const { t } = useT();
	const { thumbnails, sprites, keyframes } = plan;
	if (
		thumbnails.length === 0 &&
		sprites.length === 0 &&
		keyframes.length === 0
	) {
		return null;
	}
	return (
		<section aria-labelledby="aux-outputs-heading" className="mt-6">
			<h2
				id="aux-outputs-heading"
				className="font-medium text-sm text-zinc-200"
			>
				{t("jobDetail.auxOutputs")}
			</h2>
			<div className="mt-2 space-y-3">
				{thumbnails.length > 0 ? (
					<Group heading={t("jobDetail.thumbnailsHeading")}>
						{thumbnails.map((thumb) => (
							<AuxRow
								key={thumb.key}
								name={thumb.key}
								inline={t("jobDetail.thumbnailInline", {
									stream: thumb.streamKey,
									height: thumb.height,
									count: thumb.positions.length,
									unit: thumb.unit,
								})}
								label={t("jobDetail.auxConfigLabel", { key: thumb.key })}
								record={thumb as unknown as Record<string, unknown>}
							/>
						))}
					</Group>
				) : null}
				{sprites.length > 0 ? (
					<Group heading={t("jobDetail.spritesHeading")}>
						{sprites.map((sprite) => (
							<AuxRow
								key={sprite.key}
								name={sprite.key}
								inline={t("jobDetail.spriteInline", {
									stream: sprite.streamKey,
									distance: sprite.distance,
									unit: sprite.unit,
								})}
								label={t("jobDetail.auxConfigLabel", { key: sprite.key })}
								record={sprite as unknown as Record<string, unknown>}
							/>
						))}
					</Group>
				) : null}
				{keyframes.length > 0 ? (
					<Group heading={t("jobDetail.keyframesHeading")}>
						{keyframes.map((keyframe) => (
							<AuxRow
								key={keyframe.key}
								name={keyframe.key}
								inline={t("jobDetail.keyframeInline", {
									time: keyframe.time,
								})}
								label={t("jobDetail.auxConfigLabel", { key: keyframe.key })}
								record={keyframe as unknown as Record<string, unknown>}
							/>
						))}
					</Group>
				) : null}
			</div>
		</section>
	);
}
