import ignore from "ignore";
import * as vscode from "vscode";
import { LevvyScorer } from "./levvy";

/**
 * Called when the extension is activated. The first time the user runs one of
 * the contributed commands, VS Code loads this module and calls `activate`.
 */
export function activate(context: vscode.ExtensionContext): void {
	const recentFiles = new RecentFiles(context);
	recentFiles.seedFromOpenTabs();

	const searchCommand = vscode.commands.registerCommand(
		"betterFileSearch.search",
		async () => {
			await searchFiles(recentFiles);
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

	// Keep a most-recently-used list of files the user opens, so the search can
	// surface them first (mirroring VS Code's own "recently opened" group).
	const editorTracker = vscode.window.onDidChangeActiveTextEditor((editor) => {
		recentFiles.touch(editor?.document.uri);
	});

	context.subscriptions.push(searchCommand, toggleCommand, editorTracker);
}

/**
 * Toggle callback for the currently open search, or `undefined` when no search
 * is active. Lets the `betterFileSearch.toggleIgnored` command reach into the
 * running QuickPick without threading state through global commands.
 */
let activeToggleIgnored: (() => void | Promise<void>) | undefined;

interface Candidate {
	uri: vscode.Uri;
	relPath: string;
}

/**
 * A fuzzy file finder. Enumerates workspace files once, then re-ranks them on
 * every keystroke using the Levvy distance (lower = better match).
 */
async function searchFiles(recentFiles: RecentFiles): Promise<void> {
	const config = vscode.workspace.getConfiguration("betterFileSearch");
	const maxResults = config.get<number>("maxResults", 50);
	const basePatterns = buildExcludePatterns(config);
	const baseExclude = patternsToGlob(basePatterns);

	// Load .gitignore rules first. When they contain no negations we can fold
	// them into the walk's exclude glob, so VS Code skips ignored directories
	// entirely instead of enumerating (potentially huge) ignored trees just to
	// discard them afterwards.
	const gitignore = await buildGitignore(baseExclude);
	const useIgnoreGlobs =
		!gitignore.anyNegation && gitignore.ignoreGlobs.length > 0;
	const initialExclude = useIgnoreGlobs
		? patternsToGlob(new Set([...basePatterns, ...gitignore.ignoreGlobs]))
		: baseExclude;

	// Enumerate candidates once up front. With the gitignore globs folded in,
	// this walk never descends into ignored directories.
	const uris = await vscode.workspace.findFiles("**/*", initialExclude);
	if (uris.length === 0 && !useIgnoreGlobs) {
		vscode.window.showInformationMessage("No files found in the workspace.");
		return;
	}

	const candidates: Candidate[] = uris.map((uri) => ({
		uri,
		relPath: vscode.workspace.asRelativePath(uri),
	}));

	// Files matched by .gitignore are hidden by default, mirroring VS Code's own
	// Quick Open (which honors `search.useIgnoreFiles`). The user can toggle them
	// in via Ctrl+H while the search is open.
	const isIgnored = gitignore.isIgnored;
	let includeIgnored = false;
	let activeCandidates = candidates.filter((c) => !isIgnored(c.relPath));

	// When the gitignore globs were folded into the walk above, ignored files
	// were never enumerated. Load the full list lazily the first time the user
	// toggles ignored files on.
	let fullLoaded = !useIgnoreGlobs;

	// Recently opened files, most-recent-first. Resolved directly from disk so
	// they still surface even when gitignored (and thus skipped by the walk
	// above). Only files that still exist in the workspace are kept.
	const recentCandidates = await resolveRecentCandidates(recentFiles);
	const recentSet = new Set(recentCandidates.map((c) => c.uri.toString()));

	// Longest path across all candidates. Each candidate is padded up to this
	// length so that short paths don't get an unfair skip-cost discount.
	let maxPathLen = computeMaxPathLen(candidates, recentCandidates);

	const scorer = new LevvyScorer();

	const ignoredButton: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon("list-filter"),
		tooltip: "Toggle gitignored files (Ctrl+H)",
	};

	type Item = vscode.QuickPickItem & { uri?: vscode.Uri };
	const quickPick = vscode.window.createQuickPick<Item>();
	quickPick.title = "Better File Search";
	quickPick.placeholder = "Type to fuzzy-search files by name";
	quickPick.matchOnDescription = false;
	quickPick.buttons = [ignoredButton];
	// We do our own ranking, so disable the built-in QuickPick filtering.
	(quickPick as unknown as { sortByLabel: boolean }).sortByLabel = false;

	const updateTitle = () => {
		quickPick.title = includeIgnored
			? "Better File Search (gitignored shown)"
			: "Better File Search";
	};

	const toItem = (c: Candidate): Item => ({
		label: basename(c.relPath),
		description: c.relPath,
		uri: c.uri,
		alwaysShow: true,
	});

	// Orders candidates by match quality for the given query. Lower Levvy score
	// wins; on ties, the shorter path wins.
	const rankCandidates = (query: string, list: Candidate[]): Candidate[] =>
		list
			.map((c) => ({
				c,
				score: scorer.score(query, c.relPath, maxPathLen - c.relPath.length),
			}))
			.sort(
				(a, b) => a.score - b.score || a.c.relPath.length - b.c.relPath.length,
			)
			.map((s) => s.c);

	const rank = (query: string) => {
		const items: Item[] = [];

		// Recently opened group. With a query, only keep recents that fuzzily
		// match it (so unrelated history drops out), then order by score.
		let recent = recentCandidates;
		if (query) {
			recent = rankCandidates(
				query,
				recentCandidates.filter((c) => isFuzzyMatch(query, c.relPath)),
			);
		}
		recent = recent.slice(0, maxResults);
		if (recent.length > 0) {
			items.push({
				label: "recently opened",
				kind: vscode.QuickPickItemKind.Separator,
			});
			items.push(...recent.map(toItem));
		}

		// File results group. Exclude anything already shown under "recently
		// opened" to avoid duplicates.
		const fileCandidates = activeCandidates.filter(
			(c) => !recentSet.has(c.uri.toString()),
		);
		const results = query
			? rankCandidates(query, fileCandidates).slice(0, maxResults)
			: fileCandidates.slice(0, maxResults);
		if (results.length > 0) {
			if (items.length > 0) {
				items.push({
					label: "file results",
					kind: vscode.QuickPickItemKind.Separator,
				});
			}
			items.push(...results.map(toItem));
		}

		quickPick.items = items;
	};

	const toggleIgnored = async () => {
		includeIgnored = !includeIgnored;
		if (includeIgnored && !fullLoaded) {
			fullLoaded = true;
			quickPick.busy = true;
			try {
				// Ignored files were skipped by the initial walk; fetch them now.
				const allUris = await vscode.workspace.findFiles("**/*", baseExclude);
				const known = new Set(candidates.map((c) => c.uri.toString()));
				for (const uri of allUris) {
					if (!known.has(uri.toString())) {
						candidates.push({
							uri,
							relPath: vscode.workspace.asRelativePath(uri),
						});
					}
				}
				maxPathLen = computeMaxPathLen(candidates, recentCandidates);
			} finally {
				quickPick.busy = false;
			}
		}
		activeCandidates = includeIgnored
			? candidates
			: candidates.filter((c) => !isIgnored(c.relPath));
		updateTitle();
		rank(quickPick.value);
	};

	rank("");
	quickPick.onDidChangeValue(rank);
	quickPick.onDidTriggerButton((button) => {
		if (button === ignoredButton) {
			toggleIgnored();
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
	vscode.commands.executeCommand(
		"setContext",
		"betterFileSearch.searchActive",
		true,
	);

	quickPick.onDidHide(() => {
		activeToggleIgnored = undefined;
		vscode.commands.executeCommand(
			"setContext",
			"betterFileSearch.searchActive",
			false,
		);
		quickPick.dispose();
	});
	quickPick.show();
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

/**
 * Case-insensitive subsequence test: are all characters of `query` found in
 * `text` in order? Used to decide whether a recently opened file is relevant to
 * the current query before ranking the survivors.
 */
function isFuzzyMatch(query: string, text: string): boolean {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	let qi = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			qi++;
		}
	}
	return qi === q.length;
}

/**
 * Tracks a most-recently-used list of files the user has opened, persisted in
 * workspace storage so it survives reloads. Mirrors the "recently opened" group
 * VS Code's own Quick Open shows above fresh file results.
 */
class RecentFiles {
	private static readonly KEY = "betterFileSearch.recentFiles";
	private static readonly MAX = 100;
	private order: string[];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.order = context.workspaceState.get<string[]>(RecentFiles.KEY, []);
	}

	/** Records `uri` (a real on-disk file) as the most recently used. */
	touch(uri: vscode.Uri | undefined): void {
		if (uri?.scheme !== "file") {
			return;
		}
		const key = uri.toString();
		this.order = [key, ...this.order.filter((u) => u !== key)].slice(
			0,
			RecentFiles.MAX,
		);
		void this.context.workspaceState.update(RecentFiles.KEY, this.order);
	}

	/** Seeds the list from currently open tabs (oldest first, active last). */
	seedFromOpenTabs(): void {
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input;
				if (input instanceof vscode.TabInputText) {
					this.touch(input.uri);
				}
			}
		}
	}

	/** Returns the tracked files, most-recent-first. */
	list(): vscode.Uri[] {
		return this.order.map((u) => vscode.Uri.parse(u));
	}
}

/**
 * Resolves the recently opened files directly from disk, most-recent-first.
 *
 * They are looked up by URI rather than intersected with the workspace walk, so
 * recently opened files still surface even when they are gitignored (and were
 * therefore skipped by the walk). Files that no longer exist are dropped.
 */
async function resolveRecentCandidates(
	recentFiles: RecentFiles,
): Promise<Candidate[]> {
	const resolved = await Promise.all(
		recentFiles.list().map(async (uri) => {
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.type & vscode.FileType.File) {
					return {
						uri,
						relPath: vscode.workspace.asRelativePath(uri),
					} as Candidate;
				}
			} catch {
				// File no longer exists; drop it.
			}
			return undefined;
		}),
	);
	return resolved.filter((c): c is Candidate => c !== undefined);
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

/**
 * Loads the project's `.gitignore` rules — the same source of truth VS Code's
 * own Quick Open uses when `search.useIgnoreFiles` is enabled.
 *
 * Returns three things:
 * - `isIgnored`: an authoritative predicate (backed by the `ignore` library)
 *   reporting whether a workspace-relative path is gitignored.
 * - `ignoreGlobs`: `findFiles` exclude globs derived from the rules, used to
 *   prune ignored directories from the walk as a performance optimization.
 * - `anyNegation`: whether any rule uses negation (`!pattern`). Negations can't
 *   be expressed safely as excludes, so the caller falls back to JS filtering.
 *
 * All `.gitignore` files in the workspace are collected; each one's rules apply
 * to paths at or below the directory that contains it, matching git semantics.
 * The `.gitignore` search honors `excludeGlob` so it doesn't descend into
 * already-excluded directories (e.g. `node_modules`) hunting for nested files.
 */
async function buildGitignore(
	excludeGlob: vscode.GlobPattern | undefined,
): Promise<{
	isIgnored: (relPath: string) => boolean;
	ignoreGlobs: string[];
	anyNegation: boolean;
}> {
	const gitignoreUris = await vscode.workspace.findFiles(
		"**/.gitignore",
		excludeGlob,
	);

	const contents = await Promise.all(
		gitignoreUris.map(async (uri) => {
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				return { uri, content: doc.getText() };
			} catch {
				return undefined;
			}
		}),
	);

	const matchers: { dir: string; ig: ReturnType<typeof ignore> }[] = [];
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

	const isIgnored =
		matchers.length === 0
			? () => false
			: (relPath: string): boolean => {
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

	return { isIgnored, ignoreGlobs, anyNegation };
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
