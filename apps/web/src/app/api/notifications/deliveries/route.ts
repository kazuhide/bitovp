import { NextResponse } from "next/server";
import { routeError } from "@/lib/server/http";
import { getNotifyQueue } from "@/lib/server/queue";

/**
 * Recent notify deliveries  — reads the QUEUE, the design's
 * stated v1 trade (no delivery table; BullMQ's failed set IS the dead-letter
 * view). Completed jobs age out fast (removeOnComplete 1000), failed ones
 * park longer (removeOnFail 5000). The event payload is already the strict
 * union, so echoing kind/occurredAt/link is secret-free by construction.
 */
export async function GET() {
	try {
		const queue = getNotifyQueue();
		const [failed, completed] = await Promise.all([
			queue.getFailed(0, 19),
			queue.getCompleted(0, 19),
		]);
		const row = (state: "FAILED" | "DELIVERED") => (job: unknown) => {
			const typed = job as {
				id?: string;
				data?: { kind?: string; occurredAt?: string; link?: string };
				attemptsMade?: number;
				failedReason?: string;
			};
			return {
				id: typed.id ?? "",
				state,
				kind: typed.data?.kind ?? "UNKNOWN",
				occurredAt: typed.data?.occurredAt ?? null,
				link: typed.data?.link ?? null,
				attemptsMade: typed.attemptsMade ?? 0,
				failedReason: typed.failedReason ?? null,
			};
		};
		return NextResponse.json({
			failed: failed.map(row("FAILED")),
			completed: completed.map(row("DELIVERED")),
		});
	} catch (err) {
		return routeError(err);
	}
}
