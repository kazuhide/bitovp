import { randomUUID } from "node:crypto";
import { librarySnapshotSchema } from "@bitovp/core";
import {
	createPrismaClient,
	createTenantPrismaClient,
	requestLibrarySource,
	type Prisma,
} from "@bitovp/db";
import { expect, it } from "vitest";
import fixture from "../../../../packages/core/src/plan/__fixtures__/ai-scene-analysis-passthrough-test.plan.json";
import { createLibraryCaptureSweep } from "./capture-sweep";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
it.runIf(adminUrl && appUrl)(
	"repairs both registered HDR source roles on the ordinary tenant sweep without replacing the editorial revision",
	async () => {
		const admin = createPrismaClient(adminUrl);
		const runtime = createPrismaClient(appUrl);
		const org = randomUUID();
		const prisma = createTenantPrismaClient(runtime, org);
		try {
			await admin.organization.create({
				data: { id: org, slug: org, name: "HDR capture fixture" },
			});
			const account = await prisma.bitmovinAccount.create({
				data: { label: "Fixture", encryptedApiKey: "fixture" },
			});
			const raw = {
				...fixture,
				bitmovin: { ...fixture.bitmovin, accountId: account.id },
				aiSceneAnalysis: undefined,
				hdr10PlusStreams: [
					{
						key: "hdr",
						inputKey: "main",
						videoInputPath: "asset.mxf",
						metadataInputPath: "scene.json",
					},
				],
			};
			const job = await prisma.encodingJob.create({
				data: {
					name: "HDR capture",
					status: "FINISHED",
					plan: JSON.parse(JSON.stringify(raw)),
					bitmovinAccountId: account.id,
					bitmovinEncodingId: randomUUID(),
				},
			});
			const source = await requestLibrarySource(prisma, job.id);
			const original = librarySnapshotSchema.parse(source.snapshot);
			const old = {
				...original,
				inputs: original.inputs.filter((i) => !i.hdr10Plus),
			};
			await prisma.librarySource.update({
				where: { id: source.id },
				data: { state: "RUNNING", snapshot: old as Prisma.InputJsonObject },
			});
			const content = await prisma.content.findUniqueOrThrow({
				where: { registrationKey: source.id },
			});
			await prisma.content.update({
				where: { id: content.id },
				data: { title: "Editorial title" },
			});
			const tick = createLibraryCaptureSweep({ prisma });
			const read = async () =>
				librarySnapshotSchema.parse(
					(
						await prisma.librarySource.findUniqueOrThrow({
							where: { id: source.id },
						})
					).snapshot,
				);
			await tick();
			expect((await read()).inputs).toEqual(old.inputs);
			await prisma.librarySource.update({
				where: { id: source.id },
				data: { state: "READY" },
			});
			await tick();
			await tick();
			expect((await read()).inputs).toEqual(original.inputs);
			const changed = await prisma.librarySource.findUniqueOrThrow({
				where: { id: source.id },
			});
			await tick();
			await tick();
			expect(
				(
					await prisma.librarySource.findUniqueOrThrow({
						where: { id: source.id },
					})
				).updatedAt,
			).toEqual(changed.updatedAt);
			expect(
				await prisma.content.findUniqueOrThrow({ where: { id: content.id } }),
			).toMatchObject({ title: "Editorial title" });
			expect(
				await prisma.contentRevision.count({
					where: { contentId: content.id },
				}),
			).toBe(1);
		} finally {
			try {
				await prisma.contentRevision.deleteMany();
				await prisma.content.deleteMany();
				await prisma.librarySource.deleteMany();
				await prisma.encodingJob.deleteMany();
				await prisma.bitmovinAccount.deleteMany();
				await admin.organization.deleteMany({ where: { id: org } });
			} finally {
				await Promise.all([runtime.$disconnect(), admin.$disconnect()]);
			}
		}
	},
);
