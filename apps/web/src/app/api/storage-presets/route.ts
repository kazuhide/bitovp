import { createStoragePresetSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

export async function GET() {
	try {
		const ctx = await getServerContext();
		const presets = await ctx.prisma.storageLocationPreset.findMany({
			orderBy: { createdAt: "desc" },
		});
		return NextResponse.json(presets);
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const parsed = createStoragePresetSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const credential = await ctx.credentials.get(parsed.data.credentialId);
		if (!credential) {
			return jsonError(400, "Credential does not exist");
		}
		const preset = await ctx.prisma.storageLocationPreset.create({
			data: parsed.data,
		});
		return NextResponse.json(preset, { status: 201 });
	} catch (err) {
		return routeError(err);
	}
}
