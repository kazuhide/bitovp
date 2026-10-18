import {
	BRANDING_REQUEST_MAX_BYTES,
	BRANDING_SETTINGS_KEY,
	brandingSettingsPatchSchema,
	brandingSettingsSchema,
	inspectBrandIcon,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { readBrandingSettings } from "@/lib/server/branding";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";

const response = (value: unknown) =>
	NextResponse.json(value, {
		headers: { "Cache-Control": "private, no-store" },
	});
export async function GET() {
	try {
		return response(
			await readBrandingSettings((await getServerContext()).prisma),
		);
	} catch (err) {
		return routeError(err);
	}
}

export async function PATCH(req: Request) {
	try {
		const ctx = await getServerContext();
		if (Number(req.headers.get("content-length")) > BRANDING_REQUEST_MAX_BYTES)
			return jsonError(413, "Branding request too large");
		const reader = req.body?.getReader();
		if (!reader) return jsonError(400, "Invalid JSON");
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.byteLength;
				if (length > BRANDING_REQUEST_MAX_BYTES) {
					await reader.cancel();
					return jsonError(413, "Branding request too large");
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			return jsonError(400, "Invalid JSON");
		}
		const body = brandingSettingsPatchSchema.safeParse(raw);
		if (!body.success) return validationError(body.error);
		const next = brandingSettingsSchema.parse({
			...(await readBrandingSettings(ctx.prisma)),
			...body.data,
		});
		await ctx.prisma.appSetting.upsert({
			where: { key: BRANDING_SETTINGS_KEY },
			create: { key: BRANDING_SETTINGS_KEY, value: next },
			update: { value: next },
		});
		await writeAuditLog(
			ctx,
			{
				method: "PATCH",
				path: "/api/settings/branding",
				statusCode: 200,
				response: {
					displayName: next.displayName,
					hasIcon: next.iconDataUrl !== null,
					iconBytes: next.iconDataUrl
						? (inspectBrandIcon(next.iconDataUrl)?.bytes ?? 0)
						: 0,
				},
			},
			req,
		);
		return response(next);
	} catch (err) {
		return routeError(err);
	}
}
