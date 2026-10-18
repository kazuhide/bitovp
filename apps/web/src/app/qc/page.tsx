import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { readFeatureFlags } from "@/lib/server/feature-flags";
import { VmafLabClient } from "./vmaf-lab-client";

export const generateMetadata = localizedTitle("pageTitles.vmafLab");

export default async function QcPage() {
	// : with QC/VMAF off this surface does not exist for the
	// deployment — 404 rather than an empty page, matching the API gate.
	if (!(await readFeatureFlags()).qcVmaf) {
		notFound();
	}
	return <VmafLabClient />;
}
