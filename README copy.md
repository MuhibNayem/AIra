# AIra - CLI AI Coding Assistant

AIra is a LangGraph (LangChain JS) + Ollama powered coding assistant that runs locally from your terminal. It supports multi-turn conversations, remembers context within a session, and can safely interact with your project using an extensible toolset (filesystem, shell, refactoring chain, and more).

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- **Ollama** running locally (or remotely) with a chat-capable model pulled
  - Default model: `qwen3:latest`
  - Set `OLLAMA_BASE_URL` if Ollama is not on `http://localhost:11434`

Install dependencies:

```bash
npm install
cp .env.example .env
```

## Running AIra

### Interactive mode

```bash
node src/index.js
```

AIra will keep the conversation open. Type `exit`, `quit`, or `q` to end the session. Memory is preserved for the lifetime of the process (configurable via `--session` or `AIRA_SESSION_ID`).

### Single-shot queries

```bash
node src/index.js --ask "Summarise src/index.js"
# or shorthand without the flag
node src/index.js "List useful scripts in package.json"
```

### Session control

```bash
node src/index.js --session my-project
```

This allows you to isolate concurrent sessions or resume a previous in-memory conversation within the same process.

## Available tools

- `readFile(path)` – read UTF-8 files.
- `writeFile({ "path": string, "content": string })` – persist changes.
- `listDirectory(path)` – list files/folders (defaults to `"."`).
- `runShellCommand(command)` – execute deterministic shell commands.
- `searchFileContent({ "pattern": string, "path"?: string, "flags"?: string })` – regex search across the repo (ignores `node_modules`).
- `refactorCode({ "code": string, "instructions": string, "context"?: string })` – LLM-backed refactoring helper with rationale.

## Configuration

Environment variables:

| Variable            | Purpose                                             | Default              |
| ------------------- | --------------------------------------------------- | -------------------- |
| `OLLAMA_BASE_URL`   | URL to your Ollama instance                         | `http://localhost:11434` |
| `AIRA_LOG_LEVEL`    | `error`, `warn`, `info`, or `debug` log verbosity   | `info`               |
| `AIRA_SESSION_ID`   | Default session id when none is passed via CLI      | `cli-session`        |

## Testing & quality

- Hook your preferred test runner via `npm test` (currently not configured).
- Suggested quick checks before shipping changes:
  1. `npm run lint` (once configured).
  2. `node src/index.js --ask "self-check"` (quick smoke test of the agent).
  3. Add targeted unit tests for newly created tools/chains (see `tests/` directory for placeholders).

## Extending AIra

1. Add new tools under `src/tools/` and register them in `src/index.js`.
2. Build bespoke chains (e.g., doc generation) under `src/chains/`.
3. Adjust prompts in `src/prompts/` to fine-tune tone and behaviour.
4. Wire other agents via modules under `src/agents/`.

Each component is written in ES modules with small, composable utilities to keep the codebase approachable for further customization.
