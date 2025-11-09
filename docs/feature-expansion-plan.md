# Feature Expansion Roadmap (Target 10/10)

## 1. Collaboration & Persistence

### 1.1 Session Persistence
- Store conversation history and tool outputs on disk or pluggable backends (SQLite, Redis).
- Add commands to export/import sessions and resume across machines.
- Support configurable retention policies and secure storage locations.

### 1.2 Multi-User Support
- Introduce user identity concepts for shared environments with per-user memory.
- Provide role-based access controls (viewer, contributor, admin) governing tools and writes.

## 2. Workflow Automation

### 2.1 Task Recipes
- Package common developer flows (code review, dependency audit, refactor wizard) as reusable prompts/chains.
- Provide CLI shortcuts (`aira review src/file.js`) that scaffold agent plans automatically.

### 2.2 Batch & Queue Processing
- Enable non-interactive batch mode that consumes task files/specs.
- Integrate job queue or scheduler for running multiple requests sequentially with status reporting.

### 2.3 Git Integration
- **Goal:** Give the agent contextual awareness of the version control state and the ability to automate common Git operations.
- **Tooling:** Implement tools that can read `git status`, `git diff`, and `git log`.
- **Automated Commit Messages:** Create a workflow where the agent can be asked to "write a commit message." It will run `git diff --staged`, analyze the changes, and propose a well-formatted message that follows Conventional Commits standards.
- **Change Summarization:** Allow developers to ask "What have I been working on?" The agent would use the git log and diffs to provide a concise summary of recent changes, aiding in daily stand-ups or progress reports.
- **Branch Management:** Basic but essential workflows for creating, listing, and switching branches to reduce context-switching for the developer.

### 2.4 Project-Wide Refactoring
- **Goal:** Evolve beyond single-file edits to perform complex, structural changes across the entire codebase safely and efficiently.
- **Leverage the Code Index:** This workflow is critically dependent on the symbol and embedding index. The agent will use the index to find all usages of a function, class, or variable, ensuring no instance is missed.
- **Interactive Workflow:** For safety, this will be a guided process:
    1. User requests a project-wide change (e.g., "Rename the `old_fn` function to `new_fn`").
    2. Agent uses the index to find all affected files and presents a list to the user for confirmation.
    3. Upon approval, the agent creates a new branch and systematically applies the edits, verifying each change.
- **Use Cases:**
    - Renaming exported functions, classes, or types.
    - Changing the signature of a function and updating all its call sites.
    - Migrating from a deprecated internal API to a new one.

## 3. Integrations & Extensibility

### 3.1 IDE & API Hooks
- Expose a local REST/gRPC API for external clients.
- Build reference VS Code extension leveraging streaming thoughts and tool outputs.
- Document API contracts and authentication for remote access.

### 3.2 Plugin System
- Allow third-party tools to register via config manifests without modifying core.
- Provide lifecycle hooks (init, pre-call, post-call) for instrumentation and overrides.

## 4. Knowledge & Context Enhancements

### 4.1 Repository Intelligence
- Implement background indexing (e.g., embeddings, symbol tables) for fast retrieval.
- Provide retrieval-augmented prompts that cite file snippets or docs automatically.

### 4.2 Documentation Ingestion
- Add tooling to ingest external docs (Markdown, OpenAPI, ADRs) into a knowledge store.
- Surface citations and source metadata in agent responses.

## 5. User Experience Upgrades

### 5.1 CLI/TUI Enhancements
- Introduce dashboards showing active plan steps, token usage, and recent tool calls.
- Offer configurable output themes, verbosity levels, and transcript exports.
- Add notification integrations (desktop, Slack/webhook) for long-running tasks.

### 5.2 Model & Prompt Management
- Provide model benchmarking utilities to compare latency and cost.
- Support per-project prompt packs with overrides managed via config files.
- Implement graceful model fallback when preferred models are unavailable.

