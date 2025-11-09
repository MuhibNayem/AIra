# Production Readiness Roadmap (Target 8/10)

## 1. Stabilize Infrastructure

### 1.1 Testing & Quality Gates
- Implement unit tests for tooling adapters (`shell`, filesystem, search) covering success and failure modes.
- Add integration tests for agent invocation paths (interactive turn, diagnostics mode, refactor chain).
- Wire coverage thresholds and test execution into CI so builds fail on regressions.
- Introduce contract tests for prompt templates and diagnostics output to catch unintended changes.

### 1.2 Build & Release Automation
- Create CI workflow (e.g., GitHub Actions) that runs linting, tests, and package audits on every push.
- Add release pipeline producing versioned npm packages with changelog generation.
- Enforce semantic versioning and tag automation (release branches, prerelease handling).
- Publish signed artifacts or checksums for CLI binaries/scripts if distributed outside npm.

### 1.3 Operational Observability
- Instrument structured logging with correlation IDs for each session and tool call.
- Emit metrics (latency, error rates, token usage) via pluggable reporters (stdout, OTLP, Prometheus).
- Build a smoke-test script executed post-install/upgrade to validate core flows.
- Add health checks for long-running processes and expose readiness endpoints for future daemonization.

## 2. Harden Tooling & Security

### 2.1 Shell & Filesystem Guardrails
- Introduce allowlists/denylists for shell commands and directories per session.
- Require explicit confirmation or elevated flags for destructive operations (e.g., `rm`, writes outside workspace).
- Sandboxed execution: run shell/file actions in worker processes with resource quotas.

### 2.2 Secrets & Configuration Management
- Validate `.env`/environment variables against a schema; surface actionable errors.
- Support loading secrets from OS keychains or secret managers instead of plain text.
- Log access to sensitive configuration and mask secret values in outputs.

### 2.3 Resource Safety & Policies
- Pool Playwright browser instances with global timeouts and cleanup hooks.
- Add retry with backoff and circuit breakers for network-bound tools (web search/scrape).
- Rate-limit tool usage per session to prevent runaway recursion or accidental DoS.

### 2.4 Audit & Permissions
- Capture audit trails of tool invocations (timestamp, session, parameters summary).
- Provide CLI flags or config to set permission tiers (read-only, read-write, exec).
- Surface permission violations clearly and fail safely without partial writes.

## 3. Documentation & Support Processes

### 3.1 Runbooks & On-Call
- Author operational runbooks covering deployment, upgrades, and rollback.
- Document diagnostic procedures and common remediation paths.

### 3.2 User Guidance
- Expand README/Docs with security considerations, permission configuration, and troubleshooting.
- Provide sample configuration files for production environments (systemd, Docker, etc.).

