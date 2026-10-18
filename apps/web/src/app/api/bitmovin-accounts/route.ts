import {
	createBitmovinAccountSchema,
	isInternalHevcV2Account,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { readJson, routeError, validationError } from "@/lib/server/http";

export async function GET() {
	try {
		const ctx = await getServerContext();
		const accounts = await ctx.bitmovinAccounts.list();
		return NextResponse.json(
			accounts.map((account) => ({
				...account,
				internalHevcV2: isInternalHevcV2Account(
					account.id,
					process.env.BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID,
				),
			})),
		);
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const parsed = createBitmovinAccountSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const { label, apiKey, tenantOrgId, defaults } = parsed.data;
		const row = await ctx.bitmovinAccounts.create({
			label,
			apiKey,
			tenantOrgId,
			defaults,
		});
		return NextResponse.json(row, { status: 201 });
	} catch (err) {
		return routeError(err);
	}
}
