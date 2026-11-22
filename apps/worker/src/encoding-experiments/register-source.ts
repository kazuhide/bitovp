import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { experimentSourceSchema } from "@bitovp/core/encoding-experiments";
import {
	experimentMediaPath,
	experimentRegistrationDirectory,
	getExperimentRoot,
	hashExperimentMedia,
	readExperimentSource,
} from "@bitovp/core/encoding-experiments-files";

async function register() {
	const root = getExperimentRoot();
	const [organization, input, label, ...extra] = process.argv.slice(2);
	if (
		!root ||
		!organization ||
		!input ||
		!isAbsolute(input) ||
		!label ||
		extra.length
	)
		throw new Error(
			"Set BITOVP_EXPERIMENTS_ROOT and supply <organization UUID> <absolute media path> <label>",
		);
	const registrations = experimentRegistrationDirectory(root, organization);
	const mediaDirectory = dirname(
		experimentMediaPath(root, organization, "placeholder"),
	);
	await Promise.all([
		mkdir(registrations, { recursive: true, mode: 0o750 }),
		mkdir(mediaDirectory, { recursive: true, mode: 0o750 }),
	]);
	const tempMedia = join(mediaDirectory, `.registration-${randomUUID()}`);
	const tempReceipt = join(registrations, `.registration-${randomUUID()}`);
	try {
		await copyFile(input, tempMedia, constants.COPYFILE_EXCL);
		const sha256 = await hashExperimentMedia(tempMedia);
		const source = experimentSourceSchema.parse({ id: sha256, label, sha256 });
		const destination = experimentMediaPath(root, organization, source.id);
		const receipt = join(registrations, `${source.id}.json`);
		try {
			await link(tempMedia, destination);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "EEXIST" ||
				(await hashExperimentMedia(destination)) !== sha256
			)
				throw error;
		}
		await writeFile(tempReceipt, JSON.stringify(source), {
			flag: "wx",
			mode: 0o640,
		});
		await link(tempReceipt, receipt).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const registered = await readExperimentSource(
			root,
			organization,
			source.id,
		);
		if (registered?.sha256 !== sha256)
			throw new Error("Existing source registration does not match");
		console.log(JSON.stringify(registered));
	} finally {
		await Promise.all([
			rm(tempMedia, { force: true }),
			rm(tempReceipt, { force: true }),
		]);
	}
}

register().catch((error: unknown) => {
	console.error(
		error instanceof Error ? error.message : "Source registration failed",
	);
	process.exitCode = 1;
});
