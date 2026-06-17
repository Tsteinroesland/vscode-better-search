# BetterFileSearch

A VS Code extension that provides a better way to search files in your workspace.

## Features

- **Search Files** command (`Better File Search: Search Files`) — type a file name
  or glob pattern and pick a result to open.
- Configurable result limit and exclude globs.
- Default keybinding: `Ctrl+Alt+F` (`Cmd+Alt+F` on macOS).

## Getting Started

```bash
npm install        # install dependencies
npm run watch      # compile in watch mode
```

Then press `F5` in VS Code to launch an **Extension Development Host** with the
extension loaded. Run the command from the Command Palette (`Ctrl+Shift+P`) →
`Better File Search: Search Files`.

## Project Layout

| Path                  | Purpose                                      |
| --------------------- | -------------------------------------------- |
| `package.json`        | Extension manifest (commands, config, etc.)  |
| `src/extension.ts`    | Activation entry point and command logic     |
| `tsconfig.json`       | TypeScript compiler configuration            |
| `.vscode/launch.json` | Debug configuration (F5 to run)              |
| `dist/`               | Compiled output (generated)                  |

## Configuration

| Setting                         | Default                                  | Description                       |
| ------------------------------- | ---------------------------------------- | --------------------------------- |
| `betterFileSearch.maxResults`   | `50`                                     | Max number of results to show.    |
| `betterFileSearch.excludeGlobs` | `["**/node_modules/**", "**/.git/**"]` | Glob patterns to exclude.         |

## Packaging

Install [`vsce`](https://github.com/microsoft/vscode-vsce) and run:

```bash
npx @vscode/vsce package
```

Set a real `publisher` in `package.json` before publishing.
