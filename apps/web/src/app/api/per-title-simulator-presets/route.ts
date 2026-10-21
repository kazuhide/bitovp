import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	parsePerTitlePreset,
	serializePerTitlePreset,
} from "@/app/vod/new/per-title-simulator-preset";
import { simulatorPresetListSchema } from "@/app/vod/new/per-title-simulator-presets";
import { authError } from "@/lib/auth/route-context";
import { requireOrganizationAdmin } from "@/lib/auth/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 1024 * 1024;
const PUBLIC_CODECS = ["H264", "H265", "VP9", "AV1"] as const;
const envelopeSchema = z
	.object({
		organizationId: z.string().min(1).max(128),
		presets: z.unknown(),
	})
	.strict();
const headers = { "cache-control": "private, no-store" };

async function readPresets(organizationId: string) {
	const path = process.env.BITOVP_PER_TITLE_SIMULATOR_PRESETS_FILE;
	if (!path) return [];
	if (!isAbsolute(path)) throw new Error("Invalid preset configuration");
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	let text: string;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
			throw new Error("Invalid preset configuration");
		// One extra byte detects growth without reading beyond the original bound.
		const bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.byteLength) {
			const part = await file.read(
				bytes,
				length,
				bytes.byteLength - length,
				length,
			);
			if (!part.bytesRead) break;
			length += part.bytesRead;
		}
		if (length > stat.size) throw new Error("Invalid preset configuration");
		text = new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, length),
		);
	} finally {
		await file.close();
	}
	const envelope = envelopeSchema.parse(JSON.parse(text));
	if (envelope.organizationId !== organizationId) return [];
	const { presets } = simulatorPresetListSchema.parse({
		presets: envelope.presets,
	});
	return presets.map(({ id, label, contents }) => {
		const parsed = parsePerTitlePreset(contents, PUBLIC_CODECS);
		return {
			id,
			label,
			contents: serializePerTitlePreset(parsed.goal, parsed.reference),
		};
	});
}

export async function GET(req: Request) {
	let organizationId: string;
	try {
		organizationId = (await requireOrganizationAdmin(req.headers))
			.organizationId;
	} catch (error) {
		const response = authError(error);
		response.headers.set("cache-control", headers["cache-control"]);
		return response;
	}
	try {
		return NextResponse.json(
			{ presets: await readPresets(organizationId) },
			{ headers },
		);
	} catch {
		return NextResponse.json(
			{ error: "Per-Title presets are unavailable" },
			{ status: 503, headers },
		);
	}
}
