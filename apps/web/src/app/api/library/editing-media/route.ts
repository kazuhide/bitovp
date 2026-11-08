import { getServerContext } from "@/lib/server/context";
import { compositionSourceFacts } from "@/lib/server/library-composition";
import { editingRoute, mediaView } from "@/lib/server/library-editing-common";
export async function GET() {
	return editingRoute(async () => {
		const ctx = await getServerContext();
		const rows = await ctx.prisma.libraryMediaVersion.findMany({
			where: { state: "READY" },
			orderBy: { createdAt: "desc" },
			take: 100,
		});
		return {
			media: rows.map((row) => ({
				...mediaView(ctx, row),
				facts: compositionSourceFacts(row),
			})),
		};
	});
}
