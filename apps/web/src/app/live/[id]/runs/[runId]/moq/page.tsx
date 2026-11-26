import { notFound } from "next/navigation";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import { localizedTitle } from "@/lib/i18n/metadata";
import { getServerContext } from "@/lib/server/context";
import { MoqStandalone } from "../../../moq-standalone";

export const generateMetadata = localizedTitle("moqPlayback.title");
export default async function MoqPlayerPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string; runId: string }>;
	searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id, runId } = await params;
	if (
		!z.uuid().safeParse(id).success ||
		!z.uuid().safeParse(runId).success ||
		Object.keys((await searchParams) ?? {}).length
	)
		notFound();
	const ctx = await getServerContext();
	if (!ctx.tenant || !roleAtLeast(ctx.tenant.role, "OPERATOR")) notFound();
	const run = await ctx.prisma.liveChannelRun.findFirst({
		where: { id: runId, liveChannelId: id },
		select: { id: true, liveChannelId: true, organizationId: true },
	});
	if (
		!run ||
		run.id !== runId ||
		run.liveChannelId !== id ||
		run.organizationId !== ctx.tenant.organizationId
	)
		notFound();
	return <MoqStandalone channelId={id} runId={runId} />;
}
