# Indexing Implementation Plan

This document breaks down the work required to add a production-grade, local-first indexing stack to AIra. Tasks are ordered to reduce risk and support incremental delivery. Each task is scoped to fit within a typical development cycle; sub-tasks can be tackled in parallel by different contributors.

## 0. Foundations

- **0.1 Requirements Finalization**
  - [x] Confirm supported languages at launch (Python, Java, JavaScript/JSX, TypeScript/TSX, Go).
  - [x] Agree on maximum resource budgets (default: `maxWorkers = CPU cores`, `maxMemoryMb = 1024`, disk capped via `.aira/index` pruning and telemetry warnings).
  - [x] Define privacy/ACL constraints (respect `AIRA_FS_READ_ROOTS`, `AIRA_FS_WRITE_ROOTS`, optional `.aira/index/access.json` ACL overrides).
- **0.2 Architectural Decisions**
  - [x] Select parsing backends (Tree-sitter for Python/JS/TS/TSX/JSX/Go; Java via JDT/LSP hybrid).
  - [x] Choose persistence layers (SQLite for metadata + Chroma vector store) and cache location `.aira/index`.
  - [x] Define JSON schema for index metadata (version, language, build timestamps, ACL tags).
- **0.3 Developer Tooling**
  - [x] Add `aira index` command scaffolding with `status`, `build`, `prune`, `config`.
  - [x] Establish logging levels and telemetry events specific to indexing runs.

## 1. Symbol & AST Index

- **1.1 Parsing Pipeline**
  - [x] Integrate Tree-sitter based symbol extractors for JavaScript/TypeScript, Python, Go, and Java sources.
  - [x] Normalize AST output into language-agnostic entities (files, symbols, relations).
  - [x] Implement error handling for unparsable files (record diagnostics, skip gracefully).
  - [x] Implement file discovery and language detection scaffolding (extension-based scan).
- **1.2 Data Model**
  - [ ] Define tables for symbols, definitions, references, inheritance, and call graph edges.
  - [ ] Store per-file hashes to detect when re-indexing is necessary.
  - [ ] Record language, module path, and owning package/service tags.
  - [x] Bootstrap index metadata scaffold (`metadata.json`) for tracking schema version and timestamps.
  - [x] Create SQLite schema for scans and file catalog (see `docs/indexing-metadata-schema.md`).
- **1.3 Storage Adapter**
  - [x] Implement a Node module that writes/queries the index (using SQLite CLI bindings).
  - [ ] Build migrations to upgrade schema versions without losing prior data.
  - [ ] Add read filters that respect `AIRA_FS_READ_ROOTS` and ACL rules.
- **1.4 CLI Integration**
  - [x] `aira index build` should parse files, populate the store, and emit progress.
  - [x] `aira index build` enumerates source files and records scan summaries.
  - [x] `aira index status` returns index age, file counts, and schema version.
  - [x] Expose preview configuration via `aira index config`.
  - [ ] Expose a programmatic API (`src/indexer/symbols.js`) consumable by the agent.

## 2. Semantic Embeddings Layer

- **2.1 Chunking Strategy**
  - [ ] Choose chunk size/stride per language (semantic boundaries preferred).
  - [ ] Strip ignored directories using existing ignore utilities.
  - [ ] Attach metadata (file path, symbol id) to each chunk.
- **2.2 Embedding Backend**
  - [ ] Select the model (local HF model, `nomic-embed`, etc.) compatible with offline use.
  - [ ] Implement batching, caching, and fallback when the model is unavailable.
  - [ ] Persist vectors in the same store FAISS.
- **2.3 Retrieval Service**
  - [ ] Provide a query interface that returns both vector hits and aligned symbol metadata.
  - [ ] Add tuning knobs (topK, min similarity, filters by language/owner).
  - [ ] Surface usage metrics via telemetry.
- **2.4 Agent Wiring**
  - [ ] Introduce a tool (e.g., `searchIndex`) that the agent can call for contextual grounding.
  - [ ] Update prompts to instruct the agent to cross-check symbol data before acting.

## 3. Cross-File Metadata & Policy Filters

- **3.1 Ownership & Domains**
  - [ ] Ingest existing CODEOWNERS, service manifests, or configuration to map files → owners.
  - [ ] Store tags (e.g., `service:payments`, `tier:core`) alongside symbols.
- **3.2 Build/Test Mapping**
  - [ ] Record which build targets/tests touch each file (using manifest parsing or heuristics).
  - [ ] Provide queries like “what tests exercise this symbol?” for agent use.
- **3.3 Policy Enforcement**
  - [ ] Extend security layer to filter index queries based on user-provided ACLs.
  - [ ] Mask or omit content flagged as restricted (PII, secrets).
  - [ ] Add audit logging for index reads (who, what query, timestamp).

## 4. Incremental Updates

- **4.1 Change Detection**
  - [ ] Track file mtimes and hashes to detect stale entries.
  - [ ] Add `aira index watch` mode that tails git events or filesystem changes.
- **4.2 Partial Rebuilds**
  - [ ] Re-index only touched files/symbols and update call graph edges accordingly.
  - [ ] Remove stale entries when files are deleted or renamed.
- **4.3 Resilience**
  - [ ] Implement retry/backoff for transient parser errors.
  - [ ] Store run diagnostics so users can inspect failures (`aira index status --verbose`).

## 5. Agent Integration

- **5.1 Tool Catalog**
  - [ ] Register new tools in `buildTooling` (e.g., `resolveSymbol`, `searchIndex`, `getReferences`).
  - [ ] Document JSON schemas for each tool and add unit tests similar to existing ones.
- **5.2 Prompt Updates**
  - [ ] Update system prompts so the agent prefers indexed data over raw glob-search.
  - [ ] Provide instructions for citing file paths + symbol signatures when responding.
- **5.3 Turn Orchestration**
  - [ ] Enhance `runAgentTurn` to surface retrieval summaries in the CLI renderer.
  - [ ] Add token/latency accounting for index lookups to telemetry.

## 6. Packaging & Distribution

- **6.1 Optional Dependency Strategy**
  - [ ] Decide between bundling parser binaries vs. optional add-ons (`npm install aira-indexers`).
  - [ ] Add install scripts that fetch platform-specific assets on first run.
- **6.2 Installer UX**
  - [ ] Update README with instructions for enabling indexing, cache locations, and disk impact.
  - [x] Provide cleanup commands (`aira index prune`) for developers to reclaim space.
- **6.3 CI & Release**
  - [ ] Extend smoke tests to cover `aira index build` on a sample repo.
  - [ ] Ensure publishing pipeline includes prebuilt artifacts (if any) and generates integrity checksums.

## 7. Quality & Validation

- **7.1 Unit & Integration Tests**
  - [ ] Add suites for parsers, storage adapters, and retrieval APIs (mocking large repos).
  - [x] Cover metadata/scanner helpers with unit tests.
  - [ ] Include regression tests to confirm ACL enforcement.
- **7.2 Performance Benchmarks**
  - [ ] Measure indexing time/size across representative projects.
  - [ ] Track query latency under load; set service-level targets.
- **7.3 Pilot Rollout**
  - [ ] Dogfood on internal repositories; gather feedback on accuracy and UX.
  - [ ] Iterate on chunking thresholds, prompt instructions, and error reporting before general release.

## 8. Documentation & Support

- **8.1 User Guide**
  - [ ] Document command usage, configuration options, troubleshooting steps.
- **8.2 Runbooks**
  - [ ] Provide operational guides for resetting indexes, handling schema upgrades, and responding to failed builds.
- **8.3 Release Notes**
  - [ ] Communicate indexing feature availability, known limitations, and migration paths in changelogs.

Delivering the plan in phases (Foundations → Symbol Index → Embeddings → Metadata → Integration) allows shipping incremental value while preserving a clear path to the “full understanding” experience expected in enterprise environments.
