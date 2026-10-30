import type { LocalVmafExecution } from "@bitovp/core";
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
