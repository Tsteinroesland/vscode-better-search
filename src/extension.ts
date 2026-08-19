import ignore from "ignore";
import * as vscode from "vscode";
import { CosineScorer } from "./cosine";
import { LevvyScorer } from "./levvy";

/**
 * Called when the extension is activated. The first time the user runs one of
 * the contributed commands, VS Code loads this module and calls `activate`.
 */
export function activate(context: vscode.ExtensionContext): void {
	const searchCommand = vscode.commands.registerCommand(
		"betterFileSearch.search",
		async () => {
			await searchFiles();
		},
	);

	// Triggered by the Ctrl+H keybinding (and the QuickPick button) while a
	// search is open. Forwards to the active search's toggle, if any.
	const toggleCommand = vscode.commands.registerCommand(
		"betterFileSearch.toggleIgnored",
		() => {
			activeToggleIgnored?.();
		},
	);

	// Triggered by the Ctrl+Alt+H keybinding (and the QuickPick button) while a
	// search is open. Switches the active match algorithm.
	const toggleScorerCommand = vscode.commands.registerCommand(
		"betterFileSearch.toggleScorer",
		() => {
			activeToggleScorer?.();
		},
	);

	// Invalidate the candidate cache when files are added/removed or a .gitignore
	// changes, so a reopened search reflects the current tree. Pure content edits
	// don't change the set of paths, so they're ignored; churn inside gitignored
	// trees (build output, etc.) is ignored too so it doesn't keep busting the
	// cache. VS Code's `files.watcherExclude` already keeps node_modules and the
	// like out of these events entirely.
	const watcher = vscode.workspace.createFileSystemWatcher("**/*");
	const onFsEvent = (uri: vscode.Uri, contentChange: boolean): void => {
		const cache = workspaceCache;
		if (!cache) {
			return;
		}
		if (basename(uri.path) === ".gitignore") {
			invalidateCache();
			return;
		}
		if (contentChange) {
			return;
		}
		if (cache.isIgnored(cache.relativize(uri))) {
			return;
		}
		invalidateCache();
	};
	watcher.onDidCreate((u) => onFsEvent(u, false));
	watcher.onDidDelete((u) => onFsEvent(u, false));
	watcher.onDidChange((u) => onFsEvent(u, true));

	context.subscriptions.push(
		searchCommand,
		toggleCommand,
		toggleScorerCommand,
		watcher,
	);
}

/**
 * Toggle callback for the currently open search, or `undefined` when no search
 * is active. Lets the `betterFileSearch.toggleIgnored` command reach into the
 * running QuickPick without threading state through global commands.
 */
let activeToggleIgnored: (() => void | Promise<void>) | undefined;

/**
 * Toggle callback for switching the active match algorithm of the currently
 * open search, or `undefined` when no search is active.
 */
let activeToggleScorer: (() => void) | undefined;

interface Candidate {
	uri: vscode.Uri;
	relPath: string;
}

/**
 * Cached result of enumerating the workspace, reused across searches so that
 * reopening the picker doesn't re-walk the file system. Invalidated by the file
 * watcher in `activate`, and rebuilt when the exclude configuration or workspace
 * folders change (tracked via `signature`).
 */
interface WorkspaceCache {
	/** Identity of the config/workspace this was built for; a mismatch rebuilds. */
	signature: string;
	/** Exclude glob for a full (gitignore-inclusive) walk, used for lazy loading. */
	baseExclude: vscode.GlobPattern | undefined;
	/** Fast workspace-relative path for a URI (cheaper than `asRelativePath`). */
	relativize: (uri: vscode.Uri) => string;
	/** Whether a workspace-relative path is gitignored. */
	isIgnored: (relPath: string) => boolean;
	/** All enumerated candidates; grows to the full set via `ensureFullCandidates`. */
	candidates: Candidate[];
	/** Non-ignored subset — shown by default. Stable across lazy full loads. */
	visible: Candidate[];
	/** Longest relPath among `candidates`, for score padding. */
	maxPathLen: number;
	/** Whether gitignore globs were folded into the initial walk. */
	useIgnoreGlobs: boolean;
	/** Whether `candidates` already holds the full (gitignore-inclusive) set. */
	fullLoaded: boolean;
}

/** Cached workspace enumeration, or `undefined` when cold/invalidated. */
let workspaceCache: WorkspaceCache | undefined;
/** In-flight cache build, so concurrent opens share a single walk. */
let cacheLoading: Promise<WorkspaceCache> | undefined;

/** Drops the cache so the next search re-enumerates. Called by the watcher. */
function invalidateCache(): void {
	workspaceCache = undefined;
}

/**
 * Signature capturing everything that affects the candidate set: the workspace
 * folders and the resolved exclude patterns. A change rebuilds the cache.
 */
function cacheSignature(basePatterns: Set<string>): string {
	const folders = (vscode.workspace.workspaceFolders ?? []).map((f) =>
		f.uri.toString(),
	);
	return JSON.stringify({ folders, patterns: [...basePatterns].sort() });
}

/**
 * Returns the workspace enumeration, reusing the cache when its signature still
 * matches. Concurrent callers share one in-flight build.
 */
async function ensureCache(
	config: vscode.WorkspaceConfiguration,
): Promise<WorkspaceCache> {
	const basePatterns = buildExcludePatterns(config);
	const signature = cacheSignature(basePatterns);
	if (workspaceCache && workspaceCache.signature === signature) {
		return workspaceCache;
	}
	if (!cacheLoading) {
		cacheLoading = loadCandidates(basePatterns, signature)
			.then((c) => {
				workspaceCache = c;
				return c;
			})
			.finally(() => {
				cacheLoading = undefined;
			});
	}
	return cacheLoading;
}

/**
 * Cold-path workspace enumeration: read root .gitignore(s), fold their globs
 * into a single recursive `findFiles` walk, pick up nested .gitignore files from
 * the results, and build the candidate/visible lists.
 */
async function loadCandidates(
	basePatterns: Set<string>,
	signature: string,
): Promise<WorkspaceCache> {
	const baseExclude = patternsToGlob(basePatterns);
	const relativize = makeRelativize();

	const rootUris = rootGitignoreUris();
	const rootGitignore = await collectGitignore(rootUris);

	const useIgnoreGlobs =
		!rootGitignore.anyNegation && rootGitignore.ignoreGlobs.length > 0;
	const initialExclude = useIgnoreGlobs
		? patternsToGlob(new Set([...basePatterns, ...rootGitignore.ignoreGlobs]))
		: baseExclude;

	const uris = await vscode.workspace.findFiles("**/*", initialExclude);

	// Nested .gitignore files weren't pruned by the walk, so they appear in its
	// results. Merge their rules with the root ones. Nested rules aren't folded
	// into the walk's exclude, so they needn't be negation-free — the `ignore`
	// matcher applies them for correctness.
	const rootKeys = new Set(rootUris.map((u) => u.toString()));
	const nestedUris = uris.filter(
		(u) => basename(u.path) === ".gitignore" && !rootKeys.has(u.toString()),
	);
	const nestedGitignore = await collectGitignore(nestedUris);
	const isIgnored = buildIsIgnored([
		...rootGitignore.matchers,
		...nestedGitignore.matchers,
	]);

	const candidates: Candidate[] = uris.map((uri) => ({
		uri,
		relPath: relativize(uri),
	}));
	const visible = candidates.filter((c) => !isIgnored(c.relPath));

	return {
		signature,
		baseExclude,
		relativize,
		isIgnored,
		candidates,
		visible,
		maxPathLen: computeMaxPathLen(candidates),
		useIgnoreGlobs,
		fullLoaded: !useIgnoreGlobs,
	};
}

/**
 * Loads the gitignored files that the folded initial walk skipped, appending
 * them to `data.candidates`. Idempotent. The visible (non-ignored) set is
 * unaffected, since every file added here is by definition gitignored.
 */
async function ensureFullCandidates(data: WorkspaceCache): Promise<void> {
	if (data.fullLoaded) {
		return;
	}
	data.fullLoaded = true;
	const allUris = await vscode.workspace.findFiles("**/*", data.baseExclude);
	const known = new Set(data.candidates.map((c) => c.uri.toString()));
	for (const uri of allUris) {
		if (!known.has(uri.toString())) {
			data.candidates.push({ uri, relPath: data.relativize(uri) });
		}
	}
	data.maxPathLen = computeMaxPathLen(data.candidates);
}

/**
 * Builds a fast workspace-relative path function, mirroring
 * `vscode.workspace.asRelativePath` but without a per-call API round-trip — a
 * meaningful saving when mapping tens of thousands of URIs. In a multi-root
 * workspace the folder name is prefixed, matching the built-in API's default.
 */
function makeRelativize(): (uri: vscode.Uri) => string {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const multi = folders.length > 1;
	const entries = folders.map((f) => {
		const path = f.uri.path;
		return { name: f.name, path, prefix: path.endsWith("/") ? path : `${path}/` };
	});
	return (uri: vscode.Uri): string => {
		const p = uri.path;
		for (const e of entries) {
			if (p === e.path) {
				return multi ? e.name : "";
			}
			if (p.startsWith(e.prefix)) {
				const rel = p.slice(e.prefix.length);
				return multi ? `${e.name}/${rel}` : rel;
			}
		}
		return p;
	};
}

/**
 * A fuzzy file finder. Enumerates workspace files once, then re-ranks them on
 * every keystroke using the Levvy distance (lower = better match).
 */
async function searchFiles(): Promise<void> {
	const config = vscode.workspace.getConfiguration("betterFileSearch");
	const maxResults = config.get<number>("maxResults", 50);

	// Create and show the picker up front so it appears instantly, even on large
	// workspaces where enumerating files takes a moment. The spinner stays on
	// until the candidate list is ready.
	type Item = vscode.QuickPickItem & { uri?: vscode.Uri };
	const quickPick = vscode.window.createQuickPick<Item>();
	quickPick.title = "Better File Search";
	quickPick.placeholder = "Type to fuzzy-search files by name";
	quickPick.matchOnDescription = false;
	// We do our own ranking, so disable the built-in QuickPick filtering.
	(quickPick as unknown as { sortByLabel: boolean }).sortByLabel = false;
	quickPick.busy = true;
	quickPick.show();

	// Candidate enumeration is cached across opens and invalidated by the file
	// watcher (see `activate`). A warm cache makes reopening near-instant; a cold
	// one pays for a single workspace walk.
	const data = await ensureCache(config);

	if (data.candidates.length === 0 && !data.useIgnoreGlobs) {
		quickPick.dispose();
		vscode.window.showInformationMessage("No files found in the workspace.");
		return;
	}

	// Files matched by .gitignore are hidden by default, mirroring VS Code's own
	// Quick Open (which honors `search.useIgnoreFiles`). The user can toggle them
	// in via Ctrl+H while the search is open.
	let includeIgnored = false;
	let activeCandidates = data.visible;

	// Two interchangeable match algorithms; both return a distance (lower =
	// better). The user can switch between them via the toolbar button or the
	// Ctrl+Alt+H keybinding.
	const levvyScorer = new LevvyScorer();
	const cosineScorer = new CosineScorer();
	// Seeded from the persisted preference; toggling updates the setting so the
	// choice is remembered across opens and restarts.
	let useCosine = config.get<string>("matchAlgorithm", "cosine") !== "levvy";
	const score = (q: string, h: string, padding: number): number =>
		useCosine
			? cosineScorer.score(q, h, padding)
			: levvyScorer.score(q, h, padding);

	const scorerName = () => (useCosine ? "Cosine similarity" : "Levvy distance");
	const otherScorerName = () =>
		useCosine ? "Levvy distance" : "Cosine similarity";

	const ignoredButton: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon("list-filter"),
		tooltip: "Toggle gitignored files (Ctrl+H)",
	};
	// Rebuilt whenever the algorithm changes so its tooltip reflects the active
	// scorer and what toggling switches to. Reassigning keeps the reference used
	// for identity comparison in the button handler in sync.
	let scorerButton: vscode.QuickInputButton = buildScorerButton();
	function buildScorerButton(): vscode.QuickInputButton {
		return {
			iconPath: new vscode.ThemeIcon("arrow-swap"),
			tooltip: `Match algorithm: ${scorerName()} — switch to ${otherScorerName()} (Ctrl+Alt+H)`,
		};
	}
	const refreshButtons = () => {
		scorerButton = buildScorerButton();
		quickPick.buttons = [scorerButton, ignoredButton];
	};
	// The candidate list is ready; drop the loading spinner.
	quickPick.busy = false;

	const updateTitle = () => {
		const parts: string[] = [scorerName()];
		if (includeIgnored) {
			parts.push("gitignored shown");
		}
		quickPick.title = `Better File Search (${parts.join(", ")})`;
		refreshButtons();
	};

	const toItem = (c: Candidate): Item => ({
		label: basename(c.relPath),
		description: c.relPath,
		uri: c.uri,
		alwaysShow: true,
	});

	// Orders candidates by match quality for the given query. Lower score wins;
	// on ties, the shorter path wins.
	const rankCandidates = (query: string, list: Candidate[]): Candidate[] =>
		list
			.map((c) => ({
				c,
				score: score(query, c.relPath, data.maxPathLen - c.relPath.length),
			}))
			.sort(
				(a, b) => a.score - b.score || a.c.relPath.length - b.c.relPath.length,
			)
			.map((s) => s.c);

	const rank = (query: string) => {
		const results = query
			? rankCandidates(query, activeCandidates).slice(0, maxResults)
			: activeCandidates.slice(0, maxResults);
		quickPick.items = results.map(toItem);
	};

	const toggleIgnored = async () => {
		includeIgnored = !includeIgnored;
		if (includeIgnored && !data.fullLoaded) {
			quickPick.busy = true;
			try {
				// Ignored files were skipped by the folded walk; fetch them now.
				await ensureFullCandidates(data);
			} finally {
				quickPick.busy = false;
			}
		}
		activeCandidates = includeIgnored ? data.candidates : data.visible;
		updateTitle();
		rank(quickPick.value);
	};

	const toggleScorer = () => {
		useCosine = !useCosine;
		// Persist the choice so future searches open with the same algorithm.
		void config.update(
			"matchAlgorithm",
			useCosine ? "cosine" : "levvy",
			vscode.ConfigurationTarget.Global,
		);
		updateTitle();
		rank(quickPick.value);
	};

	rank("");
	updateTitle();
	quickPick.onDidChangeValue(rank);
	quickPick.onDidTriggerButton((button) => {
		if (button === ignoredButton) {
			toggleIgnored();
		} else if (button === scorerButton) {
			toggleScorer();
		}
	});

	quickPick.onDidAccept(async () => {
		const picked = quickPick.selectedItems[0];
		quickPick.hide();
		if (picked?.uri) {
			const doc = await vscode.workspace.openTextDocument(picked.uri);
			await vscode.window.showTextDocument(doc);
		}
	});

	// Expose the toggle and mark the search as active so the Ctrl+H keybinding
	// (gated on the `betterFileSearch.searchActive` context) can reach it.
	activeToggleIgnored = toggleIgnored;
	activeToggleScorer = toggleScorer;
	vscode.commands.executeCommand(
		"setContext",
		"betterFileSearch.searchActive",
		true,
	);

	quickPick.onDidHide(() => {
		activeToggleIgnored = undefined;
		activeToggleScorer = undefined;
		vscode.commands.executeCommand(
			"setContext",
			"betterFileSearch.searchActive",
			false,
		);
		quickPick.dispose();
	});
}

/**
 * Collects the exclude globs applied to `findFiles`.
 *
 * Combines this extension's own `excludeGlobs` setting with the user's existing
 * VS Code `files.exclude` and `search.exclude` settings (unless
 * `useWorkspaceExcludes` is disabled). Passing our own exclude to `findFiles`
 * would otherwise bypass those built-in excludes entirely.
 */
function buildExcludePatterns(
	config: vscode.WorkspaceConfiguration,
): Set<string> {
	const patterns = new Set<string>();

	for (const glob of config.get<string[]>("excludeGlobs", [])) {
		addExcludePattern(patterns, glob);
	}

	if (config.get<boolean>("useWorkspaceExcludes", true)) {
		for (const section of ["files.exclude", "search.exclude"]) {
			const dot = section.indexOf(".");
			const excludes = vscode.workspace
				.getConfiguration(section.slice(0, dot))
				.get<Record<string, boolean>>(section.slice(dot + 1), {});
			for (const [glob, enabled] of Object.entries(excludes)) {
				if (enabled) {
					addExcludePattern(patterns, glob);
				}
			}
		}
	}

	return patterns;
}

/** Folds a set of exclude patterns into a single `findFiles` glob. */
function patternsToGlob(patterns: Set<string>): vscode.GlobPattern | undefined {
	if (patterns.size === 0) {
		return undefined;
	}
	return patterns.size === 1
		? [...patterns][0]
		: `{${[...patterns].join(",")}}`;
}

/**
 * Adds a glob to the exclude set. `findFiles` matches excludes against result
 * *file* paths, so a bare folder pattern like `**​/.venv` won't hide the files
 * inside it — we also add a `/**` variant to catch the contents.
 */
function addExcludePattern(patterns: Set<string>, glob: string): void {
	const trimmed = glob.trim();
	if (!trimmed) {
		return;
	}
	patterns.add(trimmed);
	if (!trimmed.endsWith("*")) {
		patterns.add(`${trimmed.replace(/\/$/, "")}/**`);
	}
}

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? p : p.slice(i + 1);
}

/** Longest `relPath` across the given candidate lists. */
function computeMaxPathLen(...lists: Candidate[][]): number {
	let max = 0;
	for (const list of lists) {
		for (const c of list) {
			max = Math.max(max, c.relPath.length);
		}
	}
	return max;
}

type GitignoreMatcher = { dir: string; ig: ReturnType<typeof ignore> };

/**
 * The candidate root `.gitignore` locations: one at the root of each workspace
 * folder. These are read directly instead of discovered via a file walk — the
 * walk to locate them dominated first-open latency, and the root file is the
 * overwhelmingly common case. Missing files are tolerated by
 * {@link collectGitignore}, which skips anything it can't read.
 */
function rootGitignoreUris(): vscode.Uri[] {
	return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
		vscode.Uri.joinPath(folder.uri, ".gitignore"),
	);
}

/**
 * Reads the given `.gitignore` files and builds, from the same source of truth
 * VS Code's own Quick Open uses:
 * - `matchers`: authoritative `ignore`-library matchers, each rooted at the
 *   directory containing its `.gitignore` (git semantics).
 * - `ignoreGlobs`: `findFiles` exclude globs derived from the rules, used to
 *   prune ignored directories from the walk as a performance optimization.
 * - `anyNegation`: whether any rule uses negation (`!pattern`). Negations can't
 *   be expressed safely as excludes, so the caller falls back to JS filtering.
 *
 * Files that don't exist or can't be read are silently skipped.
 */
async function collectGitignore(uris: vscode.Uri[]): Promise<{
	matchers: GitignoreMatcher[];
	ignoreGlobs: string[];
	anyNegation: boolean;
}> {
	const decoder = new TextDecoder();
	const contents = await Promise.all(
		uris.map(async (uri) => {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				return { uri, content: decoder.decode(bytes) };
			} catch {
				return undefined;
			}
		}),
	);

	const matchers: GitignoreMatcher[] = [];
	const ignoreGlobs: string[] = [];
	let anyNegation = false;

	for (const entry of contents) {
		if (!entry) {
			continue;
		}
		const rel = vscode.workspace.asRelativePath(entry.uri).replace(/\\/g, "/");
		const slash = rel.lastIndexOf("/");
		const dir = slash === -1 ? "" : rel.slice(0, slash);
		matchers.push({ dir, ig: ignore().add(entry.content) });

		const { globs, hasNegation } = gitignoreToGlobs(entry.content, dir);
		if (hasNegation) {
			anyNegation = true;
		}
		ignoreGlobs.push(...globs);
	}

	return { matchers, ignoreGlobs, anyNegation };
}

/**
 * Builds the authoritative "is this workspace-relative path gitignored?"
 * predicate from a set of matchers, each rooted at the directory containing its
 * `.gitignore`.
 */
function buildIsIgnored(
	matchers: GitignoreMatcher[],
): (relPath: string) => boolean {
	if (matchers.length === 0) {
		return () => false;
	}
	return (relPath: string): boolean => {
		const path = relPath.replace(/\\/g, "/");
		for (const { dir, ig } of matchers) {
			let sub: string;
			if (dir === "") {
				sub = path;
			} else if (path === dir || path.startsWith(`${dir}/`)) {
				sub = path.slice(dir.length + 1);
			} else {
				continue;
			}
			if (sub && ig.ignores(sub)) {
				return true;
			}
		}
		return false;
	};
}

/**
 * Translates the rules in a single `.gitignore` file (located in `dir`,
 * relative to the workspace root) into `findFiles` exclude globs. These globs
 * are an optimization layered on top of the authoritative `ignore` matcher:
 * they let the file walk skip ignored directories instead of enumerating them.
 *
 * Negated rules (`!pattern`) can't be expressed as excludes without risking
 * over-exclusion, so their presence is reported via `hasNegation` and the
 * caller falls back to filtering in JS for correctness.
 */
function gitignoreToGlobs(
	content: string,
	dir: string,
): { globs: string[]; hasNegation: boolean } {
	const base = dir ? `${dir.replace(/\/$/, "")}/` : "";
	const globs: string[] = [];
	let hasNegation = false;

	for (const raw of content.split(/\r?\n/)) {
		let line = raw.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		if (line.startsWith("!")) {
			hasNegation = true;
			continue;
		}
		// Unescape a leading `\#` or `\!` (a literal `#`/`!`, not a comment or
		// negation).
		line = line.replace(/^\\([#!])/, "$1");

		let anchored = false;
		if (line.startsWith("/")) {
			anchored = true;
			line = line.slice(1);
		}
		const withoutTrailingSlash = line.replace(/\/$/, "");
		// A slash anywhere but the trailing position anchors the pattern to `dir`.
		if (withoutTrailingSlash.includes("/")) {
			anchored = true;
		}
		const dirOnly = line.endsWith("/");
		line = withoutTrailingSlash;
		if (!line) {
			continue;
		}

		const prefix = anchored ? base : `${base}**/`;
		// The entry itself may name a file, and `findFiles` matches file paths,
		// so a directory also needs a `/**` variant to catch its contents.
		if (!dirOnly) {
			globs.push(`${prefix}${line}`);
		}
		globs.push(`${prefix}${line}/**`);
	}

	return { globs, hasNegation };
}

/** Called when the extension is deactivated. */
export function deactivate(): void {
	// Nothing to clean up.
}
