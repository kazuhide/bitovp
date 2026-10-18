import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { bitmovinClientForAccount } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { routeError } from "@/lib/server/http";
import type {
	EncoderPointer,
	EncoderStateReader,
	ReconcileReport,
} from "@/lib/server/reset";
import { reconcileEncoderPointers } from "@/lib/server/reset";
import { tokenActorRefusal } from "@/lib/server/reset-actor";
import {
	type ResetAccountSnapshot,
	readResetEncoding,
	sameResetAccount,
} from "@/lib/server/reset-provider";

/**
 *  — Settings → Reset's "check with Bitmovin".
 *
 * The reset refuses while a row still names an encoder nobody confirmed
 * stopped . Before this route the operator was sent to the
 * Bitmovin dashboard to look; now the app asks the provider itself, per
 * encoding, and stamps the rows whose encoding is TERMINAL (FINISHED /
 * ERROR / CANCELED by core's `classifyProviderStatusWord`) — or CREATED,
 * which was never started, so there is nothing to stop (owner decision
 * 2026-09-07, rev431; the stamp is cleared again by every (re)start door:
 * the VOD retry route, every live PROVISIONING claim and revived run, and
 * the workers' pointer writes) — with that encoding's
 * id. QUEUED/RUNNING stay listed — the population the refusal protects.
 * A generic 404 is not absence. The reset-only reader requires exact status
 * and entity absence plus authenticated list access; reconcile also fences
 * the account version against the row's creation and through stamp commit.
 * This does not relax core lifecycle's UNKNOWN handling. Nothing at the provider
 * is stopped or deleted here: this is a READ, and a read that fails leaves
 * the row blocking (closed). ADMIN by the `/api/admin` rule; a token cannot
 * call it (same as the reset).
 */
export type ResetReconcilePointer = {
	resourceType: "vodJob" | "liveChannel";
	id: string;
	name: string | null;
	status: string;
	bitmovinEncodingId: string;
};

function customer(pointer: EncoderPointer): ResetReconcilePointer {
	return {
		resourceType: pointer.kind === "encodingJob" ? "vodJob" : "liveChannel",
		id: pointer.id,
		name: pointer.name,
		status: pointer.status,
		bitmovinEncodingId: pointer.bitmovinEncodingId,
	};
}

function customerReport(report: ReconcileReport) {
	return {
		confirmed: report.confirmed.map(customer),
		running: report.running.map((p) => ({
			...customer(p),
			providerStatus: p.providerStatus,
		})),
		unverified: report.unverified.map((p) => ({
			...customer(p),
			message: p.message,
		})),
	};
}

export async function POST(req: Request) {
	const refused = tokenActorRefusal(req);
	if (refused) {
		return refused;
	}
	try {
		const ctx = await getServerContext();
		const snapshot = (id: string) =>
			ctx.prisma.bitmovinAccount.findUnique({
				where: { id },
				select: {
					id: true,
					updatedAt: true,
					tenantOrgId: true,
					encryptedApiKey: true,
				},
			});
		const clients = new Map<
			string,
			Promise<{
				api: Awaited<ReturnType<typeof bitmovinClientForAccount>>;
				account: ResetAccountSnapshot | null;
			}>
		>();
		const read: EncoderStateReader = async (accountId, encodingId) => {
			let client = clients.get(accountId);
			if (!client) {
				client = (async () => {
					// The ordinary client reads metadata and key separately. Fence
					// both reads with the complete encrypted-account snapshot.
					const before = await snapshot(accountId);
					if (!before) return { api: null, account: null };
					const api = await bitmovinClientForAccount(ctx, accountId);
					const after = await snapshot(accountId);
					return {
						api,
						account: sameResetAccount(before, after) ? before : null,
					};
				})();
				clients.set(accountId, client);
			}
			const { api, account } = await client;
			if (!api || !account) {
				return {
					kind: "unverified",
					message:
						"The Bitmovin account is missing or changed while preparing the lookup",
				};
			}
			return readResetEncoding(api, encodingId, account);
		};
		const report = await reconcileEncoderPointers(ctx.prisma, read);
		const response = customerReport(report);
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: "/api/admin/reset/reconcile",
				statusCode: 200,
				response: {
					confirmed: response.confirmed.length,
					running: response.running.length,
					unverified: response.unverified.length,
				},
			},
			req,
		);
		return NextResponse.json(response);
	} catch (err) {
		return routeError(err);
	}
}
