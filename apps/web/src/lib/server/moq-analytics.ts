import "server-only";
import { createHash } from "node:crypto";
import {
	AnalyticsAttribute,
	AnalyticsCountQueryRequest,
	AnalyticsEqualFilter,
	AnalyticsOrder,
	AnalyticsOrderByEntry,
} from "@bitmovin/api-sdk";
import { z } from "zod";
import type { MoqAnalyticsReadback } from "@/lib/moq-player/analytics-readback";
import { MOQ_OBSERVATION_LIMITS } from "@/lib/moq-player/observations";
import { bitmovinClientForAccount } from "./bitmovin";
import {
	auditMoqHistory,
	MoqObservationError,
	type MoqObservationParams,
	moqHistoryError,
	moqObservationContext,
	parseMoqObservationStore,
	readMoqObservationRun,
} from "./moq-observations";
import { readPlayerSettings } from "./player-config";

const rowSchema = z.tuple([
	z.string().regex(/^\d{1,6}$/),
	z.iso.datetime(),
	z.number().int().positive(),
]);

export async function getMoqAnalytics(
	req: Request,
	params: MoqObservationParams,
) {
	try {
		const queryIds = new URL(req.url).searchParams.getAll("impressionId");
		const parsedId = z.uuid().safeParse(queryIds[0]);
		if (queryIds.length !== 1 || !parsedId.success)
			throw new MoqObservationError(400, "MOQ_ANALYTICS_INVALID_REQUEST");
		const impressionId = parsedId.data;
		const ctx = await moqObservationContext(req, params, false, [
			"impressionId",
		]);
		const run = await readMoqObservationRun(ctx, params);
		const videoId = `bitovp-moq:${run.bitmovinEncodingId}:${run.id}`;
		const store = parseMoqObservationStore(run.moqObservations);
		const sessions = store.sessions.filter(
			(session) => session.analyticsImpressionId === impressionId,
		);
		const session = sessions[0];
		if (
			sessions.length !== 1 ||
			!session ||
			session.analyticsVideoId !== videoId
		)
			throw new MoqObservationError(409, "MOQ_ANALYTICS_IMPRESSION_UNBOUND");
		const settings = await readPlayerSettings(ctx.prisma);
		const licenseKey = settings.analyticsLicenseKey;
		if (
			!licenseKey ||
			createHash("sha256").update(licenseKey).digest("hex") !==
				session.analyticsLicenseKeySha256
		)
			throw new MoqObservationError(409, "MOQ_ANALYTICS_LICENSE_CHANGED");
		// Query bounds use server receipt times, never the client's observation
		// clock. Include the bounded session lifetime before its first flush.
		const start = new Date(
			Date.parse(session.createdAt) -
				MOQ_OBSERVATION_LIMITS.durationMs -
				60_000,
		);
		const end = new Date(Date.parse(session.updatedAt) + 60_000);
		if (
			!Number.isFinite(start.getTime()) ||
			!Number.isFinite(end.getTime()) ||
			end <= start
		)
			throw new MoqObservationError(409, "MOQ_ANALYTICS_IMPRESSION_UNBOUND");
		const client = await bitmovinClientForAccount(
			ctx,
			run.originalBitmovinAccountId,
			AbortSignal.timeout(15_000),
		);
		if (!client)
			throw new MoqObservationError(503, "MOQ_ANALYTICS_UNAVAILABLE");
		const filters = [
			new AnalyticsEqualFilter({
				name: AnalyticsAttribute.VIDEO_ID,
				value: videoId,
			}),
			new AnalyticsEqualFilter({
				name: AnalyticsAttribute.IMPRESSION_ID,
				value: impressionId,
			}),
			new AnalyticsEqualFilter({
				name: AnalyticsAttribute.CUSTOM_DATA_2,
				value: "moq-source-barcode",
			}),
			new AnalyticsEqualFilter({
				name: AnalyticsAttribute.CUSTOM_DATA_4,
				value: run.id,
			}),
			new AnalyticsEqualFilter({
				name: AnalyticsAttribute.CUSTOM_DATA_5,
				value: run.bitmovinEncodingId,
			}),
		];
		const points: MoqAnalyticsReadback["points"] = [];
		let truncated = false;
		for (let offset = 0; offset < 600; offset += 200) {
			const result = await client.analytics.queries.count.create(
				new AnalyticsCountQueryRequest({
					licenseKey,
					start,
					end,
					filters,
					dimension: AnalyticsAttribute.IMPRESSION_ID,
					groupBy: [
						AnalyticsAttribute.CUSTOM_DATA_1,
						AnalyticsAttribute.CUSTOM_DATA_3,
					],
					orderBy: [
						new AnalyticsOrderByEntry({
							name: AnalyticsAttribute.CUSTOM_DATA_3,
							order: AnalyticsOrder.ASC,
						}),
					],
					limit: 200,
					offset,
				}),
			);
			if (!Array.isArray(result.rows) || result.rows.length > 200)
				throw new MoqObservationError(503, "MOQ_ANALYTICS_UNAVAILABLE");
			// Official query response: groupBy values in request order, aggregate
			// last. Do not return other columns or context from Analytics.
			for (const value of result.rows) {
				const row = rowSchema.safeParse(value);
				if (!row.success) continue;
				const [latency, observedAt] = row.data,
					latencyMs = Number(latency),
					at = Date.parse(observedAt);
				if (
					latencyMs <= 600_000 &&
					at >= start.getTime() &&
					at <= end.getTime()
				)
					points.push({ observedAt, latencyMs });
			}
			if (result.rows.length < 200) break;
			if (offset === 400) truncated = true;
		}
		points.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
		const result: MoqAnalyticsReadback = {
			runId: run.id,
			encodingId: run.bitmovinEncodingId,
			impressionId,
			videoId,
			source: "bitmovin-analytics-custom-data",
			measurement: "moq-source-barcode",
			nativeLatency: false,
			unit: "ms",
			status: points.length ? "available" : "pending",
			points,
			truncated,
		};
		await auditMoqHistory(ctx, req, params, 200);
		return Response.json(result, {
			headers: { "Cache-Control": "private, no-store" },
		});
	} catch (error) {
		return moqHistoryError(error);
	}
}
