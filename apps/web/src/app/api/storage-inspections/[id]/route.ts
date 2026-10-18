import { NextResponse } from "next/server";
import {
	INSPECTION_SELECT,
	type StorageInspectionRow,
	toInspectionDto,
} from "@/app/storage/inspect-shared";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Poll target for the inspect dialog: one StorageInspection row.
 *
 * The row carries no credential material (only `credentialId`), yet the
 * projection is still explicit — returning `row` would publish every column a
 * future migration adds. `probe` is the raw ffprobe JSON the worker wrote
 * through redactSecrets; `bytesRead` is what the bounded read actually pulled.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.storageInspection.findUnique({
			where: { id },
			select: INSPECTION_SELECT,
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json(toInspectionDto(row as StorageInspectionRow));
	} catch (err) {
		return routeError(err);
	}
}
