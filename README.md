# AIra – CLI AI Coding Assistant

AIra is a LangGraph (LangChain JS) + Ollama powered developer assistant that runs entirely from your terminal. It supports multi-turn conversations, remembers context within a session, and can safely interact with your project using an extensible toolset (filesystem helpers, shell execution, refactoring chains, and more).

## Features

- 🔌 **Local-first** – talk to an Ollama model you control.
- 🧰 **Rich tooling** – filesystem access, shell commands, regex search, targeted refactors, and custom tools via LangChain.
- 🧠 **Session memory** – keep context across turns with on-disk session IDs.
- 🌀 **Observable reasoning** – see the agent’s thoughts, tool calls, and results as they happen.
- 🧱 **Composable** – everything is modern ES modules; extend or embed with ease.

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- **Ollama** running locally (or remotely) with a chat-capable model pulled  
  - Default model: `qwen3:latest`  
  - Set `OLLAMA_BASE_URL` if Ollama is not on `http://localhost:11434`

## Installation

Install the CLI globally, use it on-demand with `npx`, or add it to a project:

```bash
# Global install
npm install -g aira-cli-agent

# On-demand usage
npx aira-cli-agent --help

# Project dependency (e.g., dev tool)
npm install --save-dev aira-cli-agent
```

If you keep the package local to a project, invoke it with `npx aira` or via an npm script.

For development, copy the sample env file and install dependencies:

```bash
cp .env.example .env
npm install
```

## Quick start

### Interactive mode

```bash
aira
# or when installed locally
npx aira
```

AIra keeps the conversation open. Type `exit`, `quit`, or `q` to end the session. Memory persists for the lifetime of the process (configurable via `--session` or `AIRA_SESSION_ID`).

### Single-shot queries

```bash
aira --ask "Summarise src/index.js"
# or shorthand without the flag
aira "List useful scripts in package.json"
```

### Session control

```bash
aira --session my-project
```

This isolates concurrent conversations or resumes a previous session within the same process.

## Available tools

- `readFile({ "path": string })` – read UTF-8 files.
- `writeFile({ "path": string, "content": string })` – persist changes.
- `listDirectory({ "path"?: string })` – list directory entries (defaults to `"."`).
- `resolvePath({ "query": string, "cwd"?: string, "limit"?: number })` – resolve glob-style queries to absolute paths.
- `getSystemInfo()` – return OS, architecture, and shell details.
- `runShellCommand({ "command": string })` – execute deterministic shell commands.
- `searchFileContent({ "pattern": string, "path"?: string, "flags"?: string })` – regex search across the workspace.
- `refactorCode({ "code": string, "instructions": string, "context"?: string })` – LLM-backed snippet refactoring.
- `refactorFileSegment({ "path": string, "startLine": number, "endLine": number, "instructions": string })` – apply targeted edits to a line range.
- `list_tools()` – return the full tool catalog and expected input schemas.

## Configuration

Environment variables (set via `.env`, shell exports, or CLI):

| Variable               | Purpose                                                | Default                   |
| ---------------------- | ------------------------------------------------------ | ------------------------- |
| `OLLAMA_BASE_URL`      | URL to your Ollama instance                            | `http://localhost:11434`  |
| `OLLAMA_MODEL`         | Chat model name to load from Ollama                    | `qwen3:latest`            |
| `AIRA_LOG_LEVEL`       | `error`, `warn`, `info`, or `debug` log verbosity      | `info`                    |
| `AIRA_SESSION_ID`      | Default session id when none is passed via CLI         | `cli-session`             |
| `AIRA_RECURSION_LIMIT` | Maximum LangGraph recursion depth before aborting run  | `200`                     |
| `OLLAMA_API_KEY`       | API key for Ollama web search                        | `(none)`                  |

## Development

- Run the CLI in watch mode with your favourite process manager or simply `node src/index.js`.
- Add new tools under `src/tools/` and register them in `buildTooling` within `src/index.js`.
- Build bespoke LangGraph chains under `src/chains/` and wire them into the agent.
- Adjust prompts in `src/prompts/` to fine-tune tone and behaviour.

### Quality checklist

- `npm test` (placeholder script – customise for your project).
- `node src/index.js --ask "self-check"` – quick smoke test of the agent.
- Add targeted unit tests in `tests/` when introducing new functionality.

## License

Apache-2.0 © A. K. M Muhibullah Nayem and AIra contributors.
