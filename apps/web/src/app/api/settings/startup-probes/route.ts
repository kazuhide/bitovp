import {
	assertSafeProbePrefix,
	MIN_PROBE_PREFIX_LENGTH,
	probeReaperForCredential,
	SENTINEL,
} from "@bitovp/storage";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

/**
 * Startup-probe designation .
 *
 * Probes write ONLY here — an explicitly designated credential + bucket +
 * prefix, never a defaulted customer output. The PUT proves DELETE
 * permission at designation time (a sentinel-key delete distinguishes
 * denied from not-found-with-permission on every driver): a list-only
 * credential — the product norm — fails LOUDLY now, not after ten probes
 * have leaked output. This route is the reaper module's second and last
 * legitimate importer (the repo pin holds the set closed).
 */

export const PROBE_SETTING_KEY = "live:startup-probe";

const putSchema = z.strictObject({
	credentialId: z.uuid(),
	// The Bitmovin account a probe runs under — a probe is a real live
	// encoder, so provision needs it exactly like any channel.
	bitmovinAccountId: z.uuid(),
	bucket: z.string().min(1).max(255),
	prefix: z
		.string()
		.max(512)
		// review-161-162 m8: measure the TRIMMED length — the guard trims, so
		// an all-whitespace prefix used to save fine and then make every reap
		// throw forever with no designation-time signal.
		.refine((value) => value.trim().length >= MIN_PROBE_PREFIX_LENGTH, {
			message: `prefix must be at least ${MIN_PROBE_PREFIX_LENGTH} characters (trimmed)`,
		})
		.describe("The designated probe AREA — control 3 refuses anything shorter"),
	abandonDeadlineMinutes: z.number().int().min(1).max(15).default(8),
});

export async function GET() {
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.appSetting.findUnique({
			where: { key: PROBE_SETTING_KEY },
		});
		return NextResponse.json({ designation: row?.value ?? null });
	} catch (err) {
		return routeError(err);
	}
}

export async function PUT(req: Request) {
	const parsed = putSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const body = parsed.data;
	try {
		const ctx = await getServerContext();
		const credential = await ctx.credentials.get(body.credentialId);
		if (!credential) {
			return jsonError(422, "credential does not exist");
		}
		const account = await ctx.bitmovinAccounts.get(body.bitmovinAccountId);
		if (!account) {
			return jsonError(422, "Bitmovin account does not exist");
		}
		const secretJson = await ctx.credentials.revealSecret(body.credentialId);
		let secret: Record<string, string>;
		try {
			secret = JSON.parse(secretJson) as Record<string, string>;
		} catch {
			throw new Error("Stored secret payload is corrupted");
		}
		const reaper = probeReaperForCredential({
			provider: credential.provider,
			config: (credential.config ?? {}) as Record<string, unknown>,
			secret,
		});
		const trimmed = body.prefix.trim();
		const prefix = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
		// review-161-162 m7: control 3 gates the DESIGNATION's own canary
		// delete too — the sentinel is a strictly-below child of the area, so
		// the same guard every reap passes runs here first.
		assertSafeProbePrefix(`${prefix}${SENTINEL}`, prefix);
		const verify = await reaper.verifyDeletePermission({
			bucket: body.bucket,
			prefix,
		});
		if (!verify.ok) {
			return jsonError(
				422,
				`credential cannot DELETE under the designated prefix (${verify.detail}) — probe cleanup would fail after every run`,
			);
		}
		const value = {
			credentialId: body.credentialId,
			bitmovinAccountId: body.bitmovinAccountId,
			bucket: body.bucket,
			prefix,
			abandonDeadlineMinutes: body.abandonDeadlineMinutes,
		};
		await ctx.prisma.appSetting.upsert({
			where: { key: PROBE_SETTING_KEY },
			create: { key: PROBE_SETTING_KEY, value },
			update: { value },
		});
		return NextResponse.json({ designation: value, verified: verify.detail });
	} catch (err) {
		return routeError(err);
	}
}
