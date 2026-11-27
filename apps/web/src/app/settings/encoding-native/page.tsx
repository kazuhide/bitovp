import { localizedTitle } from "@/lib/i18n/metadata";
import { NativeEncodingClient } from "./native-encoding-client";

export const generateMetadata = localizedTitle("encodingNative.title");

export default function NativeEncodingPage() {
	return <NativeEncodingClient />;
}
