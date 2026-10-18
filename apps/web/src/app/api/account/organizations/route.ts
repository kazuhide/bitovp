import { NextResponse } from "next/server";
import { authError } from "@/lib/auth/route-context";
import { listOrganizations, resolveSessionIdentity } from "@/lib/auth/tenancy";
export async function GET(req: Request) {
	try {
		const { user } = await resolveSessionIdentity(req.headers);
		return NextResponse.json(
			{ organizations: await listOrganizations(user.id) },
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		return authError(err);
	}
}
