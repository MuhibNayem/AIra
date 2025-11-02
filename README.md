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
Before the first prompt appears, AIra verifies that required environment variables (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`) are set and that the Ollama daemon is reachable; if anything is missing it prints remediation steps instead of starting.
At startup AIra now performs a quick prerequisite check (Ollama binary + default model). If something is missing it prints remediation guidance before the chat loop begins. Skip the guard with `aira --no-check` or by exporting `AIRA_NO_STARTUP_CHECK=1`.

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
| `AIRA_RECURSION_LIMIT` | Maximum LangGraph recursion depth before aborting run  | `300`                     |
| `AIRA_METRICS_PATH`    | Optional JSONL sink for telemetry events               | `(none)`                  |
| `AIRA_DEBUG_TELEMETRY` | When `1`, mirror telemetry events to stdout            | `0`                       |
| `AIRA_FS_READONLY`     | Set to `1` to force filesystem tools into read-only mode | `0`                       |
| `AIRA_FS_WRITE_ROOTS`  | Comma-separated absolute paths allowed for writes      | project root              |
| `AIRA_FS_ADDITIONAL_WRITE_ROOTS` | Extra write roots appended at runtime              | `(none)`                  |
| `AIRA_FS_READ_ROOTS`   | Comma-separated absolute paths allowed for reads       | project root              |
| `AIRA_FS_ADDITIONAL_READ_ROOTS`  | Additional read roots for temporary access            | `(none)`                  |
| `OLLAMA_API_KEY`       | API key used when enabling Ollama's web search tooling | `(none)`                  |
| `GOOGLE_API_KEY`       | Google Custom Search API key for web lookups           | `(none)`                  |
| `GOOGLE_CSE_ID`        | Google Custom Search Engine ID                         | `(none)`                  |
| `SERPER_API_KEY`       | Serper developer key for search provider fallback      | `(none)`                  |

The `.env.example` file contains the minimal defaults needed to get started. Copy it to `.env` for local development and then supply any optional search-related variables (`OLLAMA_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CSE_ID`, `SERPER_API_KEY`) as required by your workflow. Keep actual credentials out of version control—use personal `.env` files or a secrets manager instead.

## Development

- Run the CLI in watch mode with your favourite process manager or simply `node src/index.js`.
- Add new tools under `src/tools/` and register them in `buildTooling` within `src/index.js`.
- Build bespoke LangGraph chains under `src/chains/` and wire them into the agent.
- Adjust prompts in `src/prompts/` to fine-tune tone and behaviour.

### Quality checklist

- `npm test`
- `npm run smoke` – fast smoke-test harness invoking diagnostics and file tooling.
- `node src/index.js --ask "self-check"` – quick smoke test of the agent.
- Add targeted unit tests in `tests/` when introducing new functionality.

### Diagnostics

- `aira --check` – run a read-only dependency audit anywhere (detects Ollama, confirms the default model, writes a report to `reports/onboarding-report.txt`).
- `aira --check --fix` – attempt automatic remediation (pull the default model, execute `aira --ask "self-check"`); add `--skip-pull`, `--skip-self-check`, or `--no-report` to tailor the behaviour.
- `aira --health` – emits a JSON health summary (prerequisites + telemetry counters) suitable for monitoring probes.
- Append `--no-check` (or set `AIRA_NO_STARTUP_CHECK=1`) to bypass the automatic preflight when launching the interactive CLI once you already manage the required environment variables yourself.
- Use `--report <path>` to direct the diagnostic log to a custom location for sharing with your team.

### Safety guardrails

- Destructive shell commands (e.g., `rm`, `mv`, `chmod`) are blocked by default. When running in an interactive TTY the CLI will prompt you to allow once, allow for the current session, or deny.
- File reads/writes are restricted to the workspace root unless you extend the allowed roots via the environment variables above. Setting `AIRA_FS_READONLY=1` converts the agent into a read-only assistant.

## License

Apache-2.0 © A. K. M Muhibullah Nayem and AIra contributors.
