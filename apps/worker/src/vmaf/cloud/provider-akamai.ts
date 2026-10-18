import { randomBytes } from "node:crypto";
import type {
	CloudLaunch,
	VmafCloudProfile,
	VmafComputeAdapter,
} from "@bitovp/core";
import {
	hashId,
	launchSeconds,
	object,
	profileHash,
	type RestDependencies,
	restClient,
	taskName,
	waitMissing,
} from "./provider-common.js";

type Profile = Extract<VmafCloudProfile, { provider: "AKAMAI_VM" }>;

/** Region-specific public list price is a pre-submit guard, not an invoice quote. */
export function chooseAkamaiVmafType(
	types: unknown[],
	profile: Profile,
): string {
	const choices = types
		.map(object)
		.map((type) => {
			const regional = Array.isArray(type.region_prices)
				? type.region_prices
						.map(object)
						.find((price) => price.id === profile.region)
				: undefined;
			const hourly = (regional ?? object(type.price)).hourly;
			return { type, hourly };
		})
		.filter(
			({ type, hourly }) =>
				type.class === "dedicated" &&
				typeof type.id === "string" &&
				/^g[0-9]+-[a-z0-9-]+$/.test(type.id) &&
				[type.vcpus, type.memory, type.disk, hourly].every(
					(n) => typeof n === "number" && Number.isFinite(n),
				) &&
				Number(type.vcpus) >= profile.cpu &&
				Number(type.memory) >= profile.memoryMiB &&
				Number(type.disk) >= profile.diskGiB * 1024 &&
				Number(hourly) > 0 &&
				Number(hourly) <= profile.maxCostUsdPerHour,
		)
		.sort(
			(a, b) =>
				Number(a.hourly) - Number(b.hourly) ||
				String(a.type.id).localeCompare(String(b.type.id)),
		);
	const id = choices[0]?.type.id;
	if (typeof id !== "string")
		throw new Error(
			"No Akamai dedicated instance fits VMAF capacity and hourly ceiling",
		);
	return id;
}

export function akamaiUserData(profile: Profile, launch: CloudLaunch): string {
	const deadline = Math.floor(Date.parse(launch.deadline) / 1000);
	const command = [
		"docker",
		"run",
		"--rm",
		"--name",
		"vmaf-worker",
		"--cpus",
		String(profile.cpu),
		"--memory",
		`${profile.memoryMiB}m`,
		"--env-file",
		"/var/lib/bitovp/vmaf.env",
		"--entrypoint",
		"node",
		profile.image,
		"--import",
		"tsx",
		"/app/apps/worker/scripts/vmaf-cloud-worker.mjs",
	];
	// Fixed argv only: neither signed URLs nor profile strings become shell source.
	const script = `import subprocess,time\ntry:\n remaining=${deadline}-time.time()\n if remaining>0:\n  subprocess.run(${JSON.stringify(command)},timeout=max(1,remaining),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)\nfinally:\n subprocess.run(["systemctl","poweroff"],check=False)\n`;
	const config = {
		ssh_pwauth: false,
		disable_root: true,
		package_update: true,
		packages: ["docker.io", "python3"],
		bootcmd: [
			[
				"systemd-run",
				"--unit=vmaf-deadline",
				`--on-calendar=@${deadline}`,
				"--timer-property=AccuracySec=1s",
				"/usr/bin/systemctl",
				"poweroff",
			],
		],
		write_files: [
			{
				path: "/var/lib/bitovp/vmaf.env",
				permissions: "0600",
				encoding: "b64",
				content: Buffer.from(
					`VMAF_MANIFEST_URL=${launch.manifestUrl}\n`,
				).toString("base64"),
			},
			{
				path: "/var/lib/bitovp/run.py",
				permissions: "0700",
				encoding: "b64",
				content: Buffer.from(script).toString("base64"),
			},
		],
		runcmd: [
			["systemctl", "start", "docker"],
			["python3", "/var/lib/bitovp/run.py"],
		],
	};
	return Buffer.from(`#cloud-config\n${JSON.stringify(config)}\n`).toString(
		"base64",
	);
}

export function akamaiAdapter(
	profile: Profile,
	deps: RestDependencies,
): VmafComputeAdapter {
	const api = restClient(deps, async () => {
		const token = deps.akamaiToken?.() ?? process.env.AKAMAI_VMAF_TOKEN;
		if (!token) throw new Error("Missing Akamai credentials");
		return token;
	});
	const endpoint = "https://api.linode.com/v4/linode/instances";
	const profileTag = `vmaf-p-${profileHash(profile)}`;
	const owned = (vm: Record<string, unknown>) => {
		if (
			!Array.isArray(vm.tags) ||
			!vm.tags.includes("bitovp-vmaf") ||
			!vm.tags.includes(profileTag) ||
			typeof vm.label !== "string" ||
			!/^vmaf-[a-f0-9]{40}$/.test(vm.label) ||
			!vm.tags.includes(`vmaf-t-${vm.label.slice(5)}`)
		)
			throw new Error("Cloud VM ownership mismatch");
		return vm;
	};
	const url = (id: string) => {
		if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Invalid Akamai VM ID");
		return `${endpoint}/${id}`;
	};
	const read = async (id: string) => {
		const vm = await api(url(id));
		return vm ? owned(vm) : undefined;
	};
	const remove = async (id: string) => {
		if (await read(id)) await api(url(id), "DELETE");
	};
	return {
		async submit(launch) {
			launchSeconds(profile, launch, deps.now?.());
			if (!/^linode\/(ubuntu|debian)/.test(profile.bootImage))
				throw new Error("Akamai cloud-init requires an Ubuntu or Debian image");
			let instanceType = profile.instanceType;
			if (instanceType === "auto") {
				const types: unknown[] = [];
				let pages = 1;
				for (let page = 1; page <= pages; page++) {
					const result = await api(
						`https://api.linode.com/v4/linode/types?page=${page}&page_size=100`,
					);
					if (
						!result ||
						!Array.isArray(result.data) ||
						!Number.isSafeInteger(result.pages) ||
						Number(result.pages) < 1 ||
						Number(result.pages) > 100
					)
						throw new Error("Invalid Akamai instance catalog");
					pages = Number(result.pages);
					types.push(...result.data);
				}
				instanceType = chooseAkamaiVmafType(types, profile);
			}
			const type = await api(
				`https://api.linode.com/v4/linode/types/${encodeURIComponent(instanceType)}`,
			);
			if (
				!type ||
				Number(type.vcpus) < profile.cpu ||
				Number(type.memory) < profile.memoryMiB ||
				Number(type.disk) < profile.diskGiB * 1024 ||
				![type.vcpus, type.memory, type.disk].every(
					(value) => typeof value === "number" && Number.isFinite(value),
				)
			)
				throw new Error(
					"Akamai instance capacity is below the configured task requirements",
				);
			const created = await api(endpoint, "POST", {
				label: taskName(launch.taskId),
				region: profile.region,
				type: instanceType,
				image: profile.bootImage,
				root_pass: `${randomBytes(48).toString("base64url")}Aa1!`,
				booted: true,
				backups_enabled: false,
				tags: [
					"bitovp-vmaf",
					profileTag,
					`vmaf-t-${hashId(launch.taskId)}`,
					`vmaf-d-${Math.floor(Date.parse(launch.deadline) / 1000)}`,
				],
				metadata: { user_data: akamaiUserData(profile, launch) },
			});
			if (!Number.isSafeInteger(created?.id) || Number(created?.id) < 1)
				throw new Error("Akamai did not return an ID");
			return String(created?.id);
		},
		async find(id) {
			const matches = new Set<string>();
			let pages = 1;
			for (let page = 1; page <= pages; page++) {
				const result = await api(
					`${endpoint}?page=${page}&page_size=100`,
					"GET",
					undefined,
					{ "X-Filter": JSON.stringify({ label: taskName(id) }) },
				);
				if (
					!result ||
					!Array.isArray(result.data) ||
					!Number.isSafeInteger(result.pages) ||
					Number(result.pages) < 1
				)
					throw new Error("Invalid Akamai page");
				pages = Number(result.pages);
				for (const item of result.data) {
					const vm = object(item);
					if (vm.label !== taskName(id)) continue;
					owned(vm);
					matches.add(String(vm.id));
				}
			}
			if (matches.size > 1) throw new Error("Ambiguous cloud VM ownership");
			return [...matches][0];
		},
		async status(id) {
			const vm = await read(id);
			if (!vm) return "MISSING";
			if (vm.status === "running") return "RUNNING";
			// VM power state cannot prove worker success. The controller validates receipt first.
			if (["offline", "shutting_down", "deleting"].includes(String(vm.status)))
				return "FAILED";
			return "QUEUED";
		},
		cancel: remove,
		async cleanup(id) {
			await remove(id);
			await waitMissing(() => read(id), deps);
		},
	};
}
