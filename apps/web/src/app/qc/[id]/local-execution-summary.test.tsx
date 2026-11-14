import { type LocalVmafExecution, VMAF_GPU_PAIR_REASONS } from "@bitovp/core";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { LocalExecutionSummary } from "./local-execution-summary";

const cpu: LocalVmafExecution = {
	version: 1,
	requestedDecode: "cpu",
	attempts: 1,
	decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
	scoring: {
		backend: "cpu",
		implementation: "libvmaf",
		model: "vmaf_v1.0.16_3d0h",
	},
};

describe("local execution facts", () => {
	it.each([
		"cuda",
		"vulkan",
	] as const)("labels owned %s scoring separately from historical VMAFx execution", (backend) => {
		renderLocalized(
			<LocalExecutionSummary
				execution={{
					...cpu,
					selection: { requested: "AUTO" },
					scoring: {
						backend,
						implementation: "bitovp-owned",
						model: cpu.scoring.model,
						modelSha256: "a".repeat(64),
						features: [
							"cambi",
							"speed_chroma_uv",
							"integer_adm3",
							"integer_motion3",
							"psnr_y",
							"psnr_cb",
							"psnr_cr",
						],
						bitDepth: 10,
						distortedOriginal: { width: 640, height: 360, bitdepth: 8 },
						officialRevision: "b".repeat(40),
						sourceSha256: "c".repeat(64),
						device: {
							index: 0,
							name: "AMD fixture",
							uuid: "device",
							vendorId: 0x1002,
							deviceId: 1,
							integrated: true,
						},
						cpuParity: {
							checked: true,
							featureCount: 14,
							scoreCount: 2,
							maxFeatureError: 0,
							maxScoreError: 0,
						},
					},
				}}
			/>,
		);
		expect(
			screen.getByText(
				`VMAF processing: GPU (owned ${backend === "cuda" ? "CUDA" : "Vulkan"}, experimental)`,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Requested processing: Local (GPU if available)"),
		).toBeInTheDocument();
		expect(screen.queryByText(/VMAFx/)).not.toBeInTheDocument();
	});
	it("keeps historical and ordinary CPU rows unchanged", () => {
		const view = renderLocalized(<LocalExecutionSummary />);
		expect(view.container).toBeEmptyDOMElement();
		view.rerender(<LocalExecutionSummary execution={cpu} />);
		expect(view.container).toBeEmptyDOMElement();
	});
	it("does not label NVDEC decoding as GPU VMAF processing", () => {
		renderLocalized(
			<LocalExecutionSummary
				execution={{
					...cpu,
					requestedDecode: "auto",
					decode: {
						reference: { backend: "cuda" },
						distorted: { backend: "cpu", reason: "CUDA_UNSUPPORTED_CODEC" },
					},
				}}
			/>,
		);
		expect(
			screen.getByText("VMAF processing: CPU (libvmaf)"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/reference: GPU \(NVDEC\); encoded: CPU/),
		).toBeInTheDocument();
		expect(screen.getByText("CUDA_UNSUPPORTED_CODEC")).toBeInTheDocument();
		expect(screen.queryByText(/VMAFx/)).not.toBeInTheDocument();
	});
	it("shows experimental GPU scoring separately in Japanese", () => {
		renderLocalized(
			<LocalExecutionSummary
				execution={{
					...cpu,
					scoring: {
						backend: "cuda",
						implementation: "vmafx",
						model: cpu.scoring.model,
						modelSha256: "a".repeat(64),
						bitDepth: 10,
						features: ["cambi_cuda"],
						distortedOriginal: { width: 1280, height: 720, bitdepth: 8 },
					},
				}}
			/>,
			"ja",
		);
		expect(
			screen.getByText("VMAFの計算: GPU（VMAFx、試験機能）"),
		).toBeInTheDocument();
		expect(
			screen.getByText("デコード — 元映像: CPU、比較映像: CPU"),
		).toBeInTheDocument();
	});
});

it("shows an explicit CPU request and actual processor without inventing a fallback", () => {
	renderLocalized(
		<LocalExecutionSummary
			execution={{ ...cpu, selection: { requested: "CPU" } }}
		/>,
	);
	expect(
		screen.getByText("Requested processing: Local CPU"),
	).toBeInTheDocument();
	expect(
		screen.getByText("VMAF processing: CPU (libvmaf)"),
	).toBeInTheDocument();
	expect(screen.queryByText(/CPU decoding used:/)).not.toBeInTheDocument();
	expect(screen.queryByText(/Processing selection:/)).not.toBeInTheDocument();
});
it.each([
	["GPU_NOT_AVAILABLE", "No eligible GPU is available."],
	["GPU_RUNTIME_UNAVAILABLE", "The GPU runtime is unavailable."],
	["GPU_MODEL_UNSUPPORTED", "This VMAF model uses CPU processing."],
	[
		"GPU_GATE_CPU_ONLY",
		"The current GPU validation gate requires CPU processing.",
	],
])("explains automatic CPU selection %s independently of decode fallback", (reason, message) => {
	renderLocalized(
		<LocalExecutionSummary
			execution={{
				...cpu,
				selection: { requested: "AUTO", reason },
				decode: {
					reference: { backend: "cpu", reason: "CUDA_UNSUPPORTED_CODEC" },
					distorted: { backend: "cpu" },
				},
			}}
		/>,
	);
	expect(
		screen.getByText("Requested processing: Local (GPU if available)"),
	).toBeInTheDocument();
	expect(
		screen.getByText(`Processing selection: ${message}`),
	).toBeInTheDocument();
	expect(screen.getByText("CUDA_UNSUPPORTED_CODEC")).toBeInTheDocument();
	expect(
		screen.getByText("CUDA_UNSUPPORTED_CODEC").parentElement,
	).not.toHaveTextContent(reason);
});
it.each([
	[
		"GPU_PAIR_PIXEL_FORMAT",
		"GPU scoring does not compare this pair's pixel formats, so CPU scored it.",
		"この組のピクセル形式はGPUでは比較できないため、CPUで計算しました。",
	],
	[
		"GPU_PAIR_COLOR_RANGE",
		"One of the two files is full range and the other is not, so CPU scored this pair.",
		"片方の映像だけがフルレンジのため、CPUで計算しました。",
	],
	[
		"GPU_PAIR_COLOR_MATRIX",
		"The two files do not name the same colour matrix, so CPU scored this pair.",
		"2つの映像の色変換行列が同じでないため、CPUで計算しました。",
	],
	[
		"GPU_PAIR_FRAME_TIMES",
		"GPU scoring does not take the frame rates or frame times of these two files, so CPU scored this pair.",
		"2つの映像のフレームレートまたはフレーム時刻がGPUで扱えない組み合わせのため、CPUで計算しました。",
	],
	[
		"GPU_PAIR_INPUT",
		"GPU scoring does not take one of the two files, so CPU scored this pair.",
		"GPUでは計算できない映像が含まれるため、CPUで計算しました。",
	],
])("says why CPU scored a pair of a GPU measurement: %s", (reason, english, japanese) => {
	const execution: LocalVmafExecution = {
		...cpu,
		selection: { requested: "AUTO", reason },
	};
	const view = renderLocalized(<LocalExecutionSummary execution={execution} />);
	expect(
		screen.getByText("Requested processing: Local (GPU if available)"),
	).toBeInTheDocument();
	expect(
		screen.getByText(`Processing selection: ${english}`),
	).toBeInTheDocument();
	expect(
		screen.getByText("VMAF processing: CPU (libvmaf)"),
	).toBeInTheDocument();
	expect(screen.queryByText(new RegExp(reason))).not.toBeInTheDocument();
	view.unmount();
	renderLocalized(<LocalExecutionSummary execution={execution} />, "ja");
	expect(
		screen.getByText(`処理方法の選択理由: ${japanese}`),
	).toBeInTheDocument();
	expect(screen.getByText("VMAFの計算: CPU (libvmaf)")).toBeInTheDocument();
});
it("names every kind of pair that GPU scoring does not take", () => {
	// A kind without words would be shown as its code.
	for (const reason of VMAF_GPU_PAIR_REASONS) {
		const view = renderLocalized(
			<LocalExecutionSummary
				execution={{ ...cpu, selection: { requested: "AUTO", reason } }}
			/>,
		);
		expect(view.container).not.toHaveTextContent(reason);
		expect(view.container).toHaveTextContent("so CPU scored");
		view.unmount();
	}
});
it("keeps unknown safe selection codes visible without interpreting them", () => {
	renderLocalized(
		<LocalExecutionSummary
			execution={{
				...cpu,
				selection: { requested: "AUTO", reason: "FUTURE_GPU_REASON" },
			}}
		/>,
		"ja",
	);
	expect(
		screen.getByText("指定した処理方法: ローカル（GPUを自動選択）"),
	).toBeInTheDocument();
	expect(
		screen.getByText("処理方法の選択理由: FUTURE_GPU_REASON"),
	).toBeInTheDocument();
	expect(screen.queryByText(/CPUでデコードした理由/)).not.toBeInTheDocument();
});
