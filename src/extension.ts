import * as vscode from 'vscode';
import { LevvyScorer } from './levvy';

/**
 * Called when the extension is activated. The first time the user runs one of
 * the contributed commands, VS Code loads this module and calls `activate`.
 */
export function activate(context: vscode.ExtensionContext): void {
  const searchCommand = vscode.commands.registerCommand(
    'betterFileSearch.search',
    async () => {
      await searchFiles();
    }
  );

  context.subscriptions.push(searchCommand);
}

interface ScoredFile {
  uri: vscode.Uri;
  relPath: string;
  score: number;
}

/**
 * A fuzzy file finder. Enumerates workspace files once, then re-ranks them on
 * every keystroke using the Levvy distance (lower = better match).
 */
async function searchFiles(): Promise<void> {
  const config = vscode.workspace.getConfiguration('betterFileSearch');
  const maxResults = config.get<number>('maxResults', 50);
  const exclude = buildExcludeGlob(config);

  // Enumerate candidates once up front. `**/*` matches every file VS Code can
  // see in the workspace, honoring the configured exclude globs.
  const uris = await vscode.workspace.findFiles('**/*', exclude);
  if (uris.length === 0) {
    vscode.window.showInformationMessage('No files found in the workspace.');
    return;
  }

  const candidates = uris.map((uri) => {
    const relPath = vscode.workspace.asRelativePath(uri);
    return { uri, relPath, name: basename(relPath) };
  });

  // Longest basename across all candidates. Each candidate is padded up to this
  // length so that short filenames don't get an unfair skip-cost discount.
  const maxNameLen = candidates.reduce((m, c) => Math.max(m, c.name.length), 0);

  const scorer = new LevvyScorer();

  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { uri: vscode.Uri }>();
  quickPick.title = 'Better File Search';
  quickPick.placeholder = 'Type to fuzzy-search files by name';
  quickPick.matchOnDescription = false;
  // We do our own ranking, so disable the built-in QuickPick filtering.
  (quickPick as unknown as { sortByLabel: boolean }).sortByLabel = false;

  const rank = (query: string) => {
    if (!query) {
      // No query: show an arbitrary slice so the picker isn't empty.
      quickPick.items = candidates.slice(0, maxResults).map((c) => ({
        label: c.relPath,
        uri: c.uri,
        alwaysShow: true,
      }));
      return;
    }

    const scored: ScoredFile[] = candidates.map((c) => ({
      uri: c.uri,
      relPath: c.relPath,
      // Score against the basename so path depth doesn't dominate; the full
      // path is still shown as the description. Padding normalizes every
      // candidate to the longest basename so length doesn't skew the ranking.
      score: scorer.score(query, c.name, maxNameLen - c.name.length),
    }));

    scored.sort((a, b) => a.score - b.score);

    quickPick.items = scored.slice(0, maxResults).map((s) => ({
      label: basename(s.relPath),
      description: s.relPath,
      uri: s.uri,
      alwaysShow: true,
    }));
  };

  rank('');
  quickPick.onDidChangeValue(rank);

  quickPick.onDidAccept(async () => {
    const picked = quickPick.selectedItems[0];
    quickPick.hide();
    if (picked) {
      const doc = await vscode.workspace.openTextDocument(picked.uri);
      await vscode.window.showTextDocument(doc);
    }
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

/**
 * Builds the glob passed to `findFiles` to exclude unwanted paths.
 *
 * Combines this extension's own `excludeGlobs` setting with the user's existing
 * VS Code `files.exclude` and `search.exclude` settings (unless
 * `useWorkspaceExcludes` is disabled). Passing our own exclude to `findFiles`
 * would otherwise bypass those built-in excludes entirely.
 */
function buildExcludeGlob(
  config: vscode.WorkspaceConfiguration
): vscode.GlobPattern | undefined {
  const patterns = new Set<string>();

  for (const glob of config.get<string[]>('excludeGlobs', [])) {
    addExcludePattern(patterns, glob);
  }

  if (config.get<boolean>('useWorkspaceExcludes', true)) {
    for (const section of ['files.exclude', 'search.exclude']) {
      const dot = section.indexOf('.');
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

  if (patterns.size === 0) {
    return undefined;
  }
  return patterns.size === 1
    ? [...patterns][0]
    : `{${[...patterns].join(',')}}`;
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
  if (!trimmed.endsWith('*')) {
    patterns.add(`${trimmed.replace(/\/$/, '')}/**`);
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.slice(i + 1);
}

/** Called when the extension is deactivated. */
export function deactivate(): void {
  // Nothing to clean up.
}
