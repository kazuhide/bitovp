import { localizedTitle } from "@/lib/i18n/metadata";
import { NativeCodecClient } from "./native-codec-client";

export const generateMetadata = localizedTitle("encodingNative.title");

export default function NativeCodecPage() {
	return <NativeCodecClient />;
}
