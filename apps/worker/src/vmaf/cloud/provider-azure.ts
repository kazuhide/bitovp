import { DefaultAzureCredential } from "@azure/identity";
import type { VmafCloudProfile, VmafComputeAdapter } from "@bitovp/core";
import {
	hashId,
	httpsEndpoint,
	launchSeconds,
	object,
	profileHash,
	type RestDependencies,
	restClient,
	taskName,
	waitMissing,
} from "./provider-common.js";

type Profile = Extract<VmafCloudProfile, { provider: "AZURE_BATCH" }>;

function automaticPool(profile: Profile, template: Record<string, unknown>) {
	// Ddsv5 has 4 GiB RAM and 37.5 GiB temporary storage per vCPU.
	// Reserve 10% of temporary storage for Batch metadata and runtime overhead.
	// https://learn.microsoft.com/azure/virtual-machines/sizes/general-purpose/ddsv5-series
	const cpu = [4, 8, 16, 32, 48, 64, 96].find(
		(count) =>
			count >= profile.cpu &&
			count * 4096 >= profile.memoryMiB &&
			count * 37.5 * 0.9 >= profile.diskGiB,
	);
	if (!cpu) throw new Error("Azure VM capacity cannot satisfy this pair");
	// The data-plane auto-pool specification cannot assign managed identities.
	if (
		template.identity ||
		/"(?:identityReference|nodeIdentityReference)"/.test(
			JSON.stringify(template),
		)
	)
		throw new Error(
			"Azure template identity is unsupported by automatic pools",
		);
	const vm = object(template.virtualMachineConfiguration);
	if (vm.osDisk && object(vm.osDisk).ephemeralOSDiskSettings)
		throw new Error("Azure template ephemeral OS disk consumes task storage");
	const containers = object(vm.containerConfiguration);
	if (Array.isArray(containers.containerRegistries)) {
		for (const item of containers.containerRegistries) {
			const registry = object(item);
			if (registry.username && !registry.password)
				throw new Error("Azure template registry credentials are unavailable");
		}
	}
	// Copy supported configuration only, never the template's capacity or status.
	const copied = Object.fromEntries(
		[
			"virtualMachineConfiguration",
			"networkConfiguration",
			"startTask",
			"applicationPackageReferences",
			"mountConfiguration",
			"userAccounts",
			"enableInterNodeCommunication",
			"upgradePolicy",
		]
			.filter((key) => template[key] !== undefined)
			.map((key) => [key, template[key]]),
	);
	return {
		...copied,
		vmSize: `Standard_D${cpu}ds_v5`,
		enableAutoScale: false,
		targetDedicatedNodes: profile.spot ? 0 : 1,
		targetLowPriorityNodes: profile.spot ? 1 : 0,
		taskSlotsPerNode: 1,
	};
}
export function azureAdapter(
	profile: Profile,
	deps: RestDependencies,
): VmafComputeAdapter {
	const endpoint = httpsEndpoint(profile.accountUrl, ".batch.azure.com");
	const credential = new DefaultAzureCredential();
	const api = restClient(
		deps,
		deps.azureToken ??
			(async () => {
				const token = await credential.getToken(
					"https://batch.core.windows.net/.default",
				);
				if (!token) throw new Error("Missing Azure credentials");
				return token.token;
			}),
	);
	const url = (path: string) => `${endpoint}${path}?api-version=2025-06-01`;
	const jobPath = (id: string) => {
		if (!/^vmaf-[a-f0-9]{40}$/.test(id))
			throw new Error("Invalid Azure job ID");
		return `/jobs/${id}`;
	};
	const read = async (id: string) => {
		const job = await api(url(jobPath(id)));
		if (!job) return undefined;
		if (!Array.isArray(job.metadata))
			throw new Error("Cloud job ownership missing");
		const metadata = Object.fromEntries(
			job.metadata.map((item) => {
				const entry = object(item);
				return [entry.name, entry.value];
			}),
		);
		if (
			metadata["vmaf-profile"] !== profileHash(profile) ||
			`vmaf-${metadata["vmaf-task"]}` !== id
		)
			throw new Error("Cloud job ownership mismatch");
		return job;
	};
	const remove = async (id: string) => {
		if (await read(id)) await api(url(jobPath(id)), "DELETE");
	};
	return {
		async submit(launch) {
			const seconds = launchSeconds(profile, launch, deps.now?.());
			const pool = await api(
				url(`/pools/${encodeURIComponent(profile.poolId)}`),
			);
			if (
				!pool ||
				!object(pool.virtualMachineConfiguration).containerConfiguration
			)
				throw new Error("Azure pool must support Linux containers");
			const vm = object(pool.virtualMachineConfiguration);
			if (
				typeof vm.nodeAgentSKUId !== "string" ||
				!/^batch\.node\.(ubuntu|debian|centos|rocky|alma|sles|opensuse)/.test(
					vm.nodeAgentSKUId,
				)
			)
				throw new Error("Azure pool must use Linux nodes");
			const poolSpecification = automaticPool(profile, pool);
			const id = taskName(launch.taskId);
			// One create owns both job and manager task, avoiding a half-created two-POST launch.
			const created = await api(url("/jobs"), "POST", {
				id,
				poolInfo: {
					autoPoolSpecification: {
						autoPoolIdPrefix: "vmaf",
						poolLifetimeOption: "job",
						keepAlive: false,
						pool: poolSpecification,
					},
				},
				metadata: [
					{ name: "vmaf-profile", value: profileHash(profile) },
					{ name: "vmaf-task", value: hashId(launch.taskId) },
					{ name: "vmaf-deadline", value: launch.deadline },
				],
				constraints: {
					maxWallClockTime: `PT${Math.floor((Date.parse(launch.deadline) - (deps.now?.() ?? Date.now())) / 1000)}S`,
					maxTaskRetryCount: 0,
				},
				jobManagerTask: {
					id: "vmaf-worker",
					commandLine:
						'/bin/sh -c \'test -n "$AZ_BATCH_TASK_WORKING_DIR" && export TMPDIR="$AZ_BATCH_TASK_WORKING_DIR" && exec node --import tsx /app/apps/worker/scripts/vmaf-cloud-worker.mjs\'',
					environmentSettings: [
						{ name: "VMAF_MANIFEST_URL", value: launch.manifestUrl },
					],
					containerSettings: {
						imageName: profile.image,
						workingDirectory: "containerImageDefault",
						containerRunOptions: `--cpus ${profile.cpu} --memory ${profile.memoryMiB}m`,
					},
					constraints: {
						maxWallClockTime: `PT${seconds}S`,
						maxTaskRetryCount: 0,
						retentionTime: "PT1H",
					},
					killJobOnCompletion: true,
					runExclusive: true,
					allowLowPriorityNode: profile.spot,
				},
			});
			if (!created) throw new Error("Azure job creation failed");
			return id;
		},
		async find(id) {
			const providerId = taskName(id);
			return (await read(providerId)) ? providerId : undefined;
		},
		async status(id) {
			const job = await read(id);
			if (!job) return "MISSING";
			const task = await api(url(`${jobPath(id)}/tasks/vmaf-worker`));
			if (task?.state === "completed") {
				const execution = object(task.executionInfo);
				return execution.result === "success" && execution.exitCode === 0
					? "SUCCEEDED"
					: "FAILED";
			}
			if (["completed", "deleting", "terminating"].includes(String(job.state)))
				return "FAILED";
			return task?.state === "running" ? "RUNNING" : "QUEUED";
		},
		async cancel(id) {
			if (await read(id))
				await api(url(`${jobPath(id)}/terminate`), "POST", {
					terminateReason: "VMAF task stopped",
				});
		},
		async cleanup(id) {
			await remove(id);
			await waitMissing(() => read(id), deps);
		},
	};
}
