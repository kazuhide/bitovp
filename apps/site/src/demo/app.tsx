import { DEFAULT_FEATURE_FLAGS } from "@bitovp/core";
import {
	Component,
	type ErrorInfo,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useState,
} from "react";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { ThemeProvider } from "@/components/theme-provider";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { LocaleProvider, persistLocale, useT } from "@/lib/i18n/context";
import { resolveTheme, THEME_COOKIE } from "@/lib/theme";
import { useDemoRoute } from "../shims/navigation";
import {
	localePath,
	SITE_METADATA,
	type SiteLocale,
	USER_GUIDE_URLS,
} from "../site-config";
import { DEMO_TEXT } from "./text";
import {
	DEMO_LIMITATION_EVENT,
	installDemoTransport,
	resetDemoData,
} from "./transport";
import "./theme.css";
import "./demo.css";

const Dashboard = lazy(() =>
	import("@/app/dashboard-home").then((m) => ({ default: m.DashboardHome })),
);
const Jobs = lazy(() =>
	import("@/app/vod/jobs/jobs-client").then((m) => ({ default: m.JobsClient })),
);
const Job = lazy(() =>
	import("@/app/vod/jobs/[id]/job-detail").then((m) => ({
		default: m.JobDetail,
	})),
);
const VodWizard = lazy(() =>
	import("@/app/vod/new/wizard").then((m) => ({ default: m.VodWizard })),
);
const CopyVodJob = lazy(() =>
	import("@/app/vod/new/copy-job").then((m) => ({ default: m.CopyVodJob })),
);
const Channels = lazy(() =>
	import("@/app/live/channels-client").then((m) => ({
		default: m.ChannelsClient,
	})),
);
const Channel = lazy(() =>
	import("@/app/live/[id]/channel-detail").then((m) => ({
		default: m.ChannelDetail,
	})),
);
const LiveWizard = lazy(() =>
	import("@/app/live/new/live-wizard").then((m) => ({ default: m.LiveWizard })),
);
const QualityReport = lazy(() =>
	import("@/app/qc/[id]/vmaf-report").then((m) => ({ default: m.VmafReport })),
);
const QualityLab = lazy(() =>
	import("@/app/qc/vmaf-lab-client").then((m) => ({
		default: m.VmafLabClient,
	})),
);

function preference(name: string) {
	return document.cookie
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`))
		?.slice(name.length + 1);
}

function DemoScope() {
	const { locale } = useT();
	const text = DEMO_TEXT[locale];
	return (
		<section className="mx-auto max-w-3xl space-y-5 py-8">
			<h1 className="font-semibold text-2xl text-zinc-100">
				{text.scopeTitle}
			</h1>
			<p className="text-sm text-zinc-400">{text.scopeBody}</p>
			<ul className="space-y-3 text-emerald-400 underline">
				<li>
					<a href="#/demo">{text.dashboardLink}</a>
				</li>
				<li>
					<a href="#/demo/vod/jobs">{text.jobsLink}</a>
				</li>
				<li>
					<a href="#/demo/vod/new">{text.newJobLink}</a>
				</li>
				<li>
					<a href="#/demo/live">{text.channelsLink}</a>
				</li>
				<li>
					<a href="#/demo/live/new">{text.newChannelLink}</a>
				</li>
				<li>
					<a href="#/demo/qc">{text.qualityLink}</a>
				</li>
			</ul>
			<a
				href={USER_GUIDE_URLS[locale]}
				className="inline-block text-sm text-emerald-400 underline"
			>
				{text.guideLink}
			</a>
		</section>
	);
}

function Screen({ route }: { route: string }) {
	const { locale } = useT();
	const text = DEMO_TEXT[locale];
	const url = new URL(route, "https://demo.invalid");
	const path = url.pathname;
	if (path === "/") return <Dashboard />;
	if (path === "/vod/jobs") return <Jobs />;
	if (path === "/vod/new") {
		const from = url.searchParams.get("from");
		return from ? (
			<CopyVodJob source={from} submitLabel={text.createJob} />
		) : (
			<VodWizard
				presetName={url.searchParams.get("preset") ?? undefined}
				submitLabel={text.createJob}
			/>
		);
	}
	const job = /^\/vod\/jobs\/([^/]+)$/.exec(path);
	if (job?.[1]) return <Job id={job[1]} />;
	if (path === "/live") return <Channels />;
	if (path === "/live/new")
		return (
			<LiveWizard
				duplicateFrom={url.searchParams.get("from") ?? undefined}
				submitLabel={text.createChannel}
			/>
		);
	const channel = /^\/live\/([^/]+)$/.exec(path);
	if (channel?.[1]) return <Channel id={channel[1]} />;
	const quality = /^\/qc\/([^/]+)$/.exec(path);
	if (quality?.[1]) return <QualityReport id={quality[1]} />;
	if (path === "/qc") return <QualityLab />;
	return <DemoScope />;
}

class ScreenBoundary extends Component<
	{ children: ReactNode; locale: SiteLocale },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(error, info);
	}
	render() {
		const text = DEMO_TEXT[this.props.locale];
		return this.state.failed ? (
			<div role="alert" className="space-y-3 py-8">
				<p>{text.screenError}</p>
				<a className="text-emerald-400 underline" href="#/demo">
					{text.returnDashboard}
				</a>
			</div>
		) : (
			this.props.children
		);
	}
}

export default function DemoApp({ locale }: { locale: SiteLocale }) {
	const route = useDemoRoute();
	const [theme] = useState(() => resolveTheme(preference(THEME_COOKIE)));
	const text = DEMO_TEXT[locale];
	const [notice, setNotice] = useState("");
	installDemoTransport();
	useEffect(() => {
		// The URL selects the static document and its GUI language, including on refresh.
		try {
			persistLocale(locale);
		} catch {
			/* The URL remains authoritative when preference cookies are unavailable. */
		}
		document.documentElement.dataset.theme = theme;
		document.documentElement.lang = locale;
		document.title = DEMO_TEXT[locale].title;
		return () => {
			document.documentElement.dataset.theme = "paper";
			document.documentElement.lang = locale;
			document.title = SITE_METADATA[locale].title;
		};
	}, [locale, theme]);
	useEffect(() => {
		window.scrollTo(0, 0);
		setNotice("");
	}, [route]);
	useEffect(() => {
		const limitation = (event: Event) => {
			if (event instanceof CustomEvent && typeof event.detail === "string")
				setNotice(locale === "ja" ? DEMO_TEXT.ja.limitation : event.detail);
		};
		window.addEventListener(DEMO_LIMITATION_EVENT, limitation);
		return () => window.removeEventListener(DEMO_LIMITATION_EVENT, limitation);
	}, [locale]);
	useEffect(() => {
		const download = async (event: MouseEvent) => {
			const anchor =
				event.target instanceof Element ? event.target.closest("a") : null;
			if (!anchor) return;
			const url = new URL(anchor.href, window.location.href);
			if (
				url.origin === window.location.origin &&
				url.pathname === window.location.pathname &&
				url.hash.startsWith("#") &&
				!url.hash.startsWith("#/demo")
			) {
				const target = document.getElementById(url.hash.slice(1));
				if (target) {
					event.preventDefault();
					target.scrollIntoView();
					target.focus({ preventScroll: true });
					return;
				}
			}
			if (
				url.origin !== window.location.origin ||
				!url.pathname.startsWith("/api/")
			)
				return;
			event.preventDefault();
			try {
				const response = await fetch(url.href);
				if (!response.ok) throw new Error(DEMO_TEXT[locale].downloadError);
				const objectUrl = URL.createObjectURL(await response.blob());
				const link = document.createElement("a");
				link.href = objectUrl;
				link.download =
					url.searchParams.get("format") === "csv"
						? "demo-report.csv"
						: "demo-report.json";
				link.click();
				setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
			} catch {
				setNotice(DEMO_TEXT[locale].downloadError);
			}
		};
		document.addEventListener("click", download);
		return () => document.removeEventListener("click", download);
	}, [locale]);
	return (
		<LocaleProvider locale={locale}>
			<FeatureFlagsProvider flags={{ ...DEFAULT_FEATURE_FLAGS, qcVmaf: true }}>
				<ThemeProvider initialTheme={theme}>
					<Providers>
						<div className="demo-workspace min-h-screen bg-zinc-950 text-zinc-200 antialiased">
							<div className="demo-banner">
								<p>
									<strong>{text.bannerTitle}</strong> {text.bannerBody}
								</p>
								<div className="demo-banner-actions">
									<details>
										<summary>{text.limitsLabel}</summary>
										<p className="demo-limits">{text.limitsBody}</p>
									</details>
									<button
										type="button"
										onClick={() => {
											resetDemoData();
											window.location.hash = "#/demo";
											window.location.reload();
										}}
									>
										{text.reset}
									</button>
									<a href={localePath(locale)}>{text.about}</a>
								</div>
							</div>
							{notice ? (
								<p role="status" className="demo-notice">
									{notice}
								</p>
							) : null}
							<AppShell>
								<ScreenBoundary key={route} locale={locale}>
									<Suspense
										fallback={
											<p role="status" className="py-8">
												{text.loading}
											</p>
										}
									>
										<Screen route={route} />
									</Suspense>
								</ScreenBoundary>
							</AppShell>
						</div>
					</Providers>
				</ThemeProvider>
			</FeatureFlagsProvider>
		</LocaleProvider>
	);
}
