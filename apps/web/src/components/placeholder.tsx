type PlaceholderProps = {
	title: string;
	phase: string;
	description: string;
};

/** Stand-in for screens whose phase has not landed yet . */
export function Placeholder({ title, phase, description }: PlaceholderProps) {
	return (
		<section>
			<header className="flex items-center gap-3">
				<h1 className="font-semibold text-xl text-zinc-50">{title}</h1>
				<span className="rounded-full border border-zinc-700 px-2 py-0.5 font-medium text-xs text-zinc-400">
					{phase}
				</span>
			</header>
			<div className="mt-6 rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center">
				<p className="text-sm text-zinc-400">{description}</p>
			</div>
		</section>
	);
}
