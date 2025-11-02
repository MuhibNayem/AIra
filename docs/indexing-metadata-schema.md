# Index Metadata Schema (v1)

The indexing subsystem stores its operational state in `.aira/index/metadata.json`.  
This document defines the JSON structure for schema version 1, used by the preview indexer.

```jsonc
{
  "schemaVersion": 1,
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp",
  "state": "initialized | scanned | indexed | error",
  "filesIndexed": 0,
  "languages": ["python", "javascript"],
  "notes": "human readable status",

  "resources": {
    "maxWorkers": 4,
    "maxMemoryMb": 1024,
    "diskBudgetMb": 2048
  },

  "persistence": {
    "metadata": {
      "driver": "sqlite",
      "path": "/abs/path/.aira/index/index.db",
      "status": "pending | ready | error"
    },
    "vectors": {
      "driver": "chroma",
      "path": "/abs/path/.aira/index/chroma",
      "status": "pending | ready | error"
    }
  },

  "acl": {
    "enforced": true,
    "readRoots": ["/abs/path/project"],
    "writeRoots": ["/abs/path/project"]
  },

  "parsers": {
    "python":  { "strategy": "tree-sitter", "status": "pending | ready | error" },
    "java":    { "strategy": "jdt+lsp",    "status": "pending | ready | error" },
    "javascript": { "strategy": "tree-sitter", "status": "pending | ready | error" },
    "typescript": { "strategy": "tree-sitter", "status": "pending | ready | error" },
    "go": { "strategy": "tree-sitter", "status": "pending | ready | error" }
  },

  "artifacts": {
    "metadataPath": "/abs/path/.aira/index/metadata.json",
    "indexRoot": "/abs/path/.aira/index"
  },

  "lastCommand": {
    "type": "build | status | prune | watch",
    "at": "ISO-8601 timestamp",
    "options": { "ext": "ts" }
  },

  "lastScan": {
    "at": "ISO-8601 timestamp",
    "cwd": "/abs/path/project",
    "totalFiles": 123,
    "durationMs": 42,
    "pattern": "**/*.{ts,tsx,js,jsx}",
    "extensions": [".ts", ".tsx"],
    "countsByLanguage": { "typescript": 100, "javascript": 23 },
    "countsByExtension": { "ts": 90, "tsx": 10 },
    "symbolCount": 42,
    "relationCount": 12,
    "symbolErrors": [
      { "file": "/abs/path/src/app.ts", "message": "parse error", "severity": "error" }
    ],
    "symbolDiagnostics": [
      {
        "file": "/abs/path/src/app.ts",
        "severity": "warning",
        "message": "Tree-sitter detected syntax errors while parsing /abs/path/src/app.ts.",
        "location": { "start": { "line": 12, "column": 5 }, "end": { "line": 12, "column": 7 } }
      }
    ],
    "relations": [
      {
        "type": "belongs_to",
        "sourceId": "/abs/path/src/app.ts#sayHi:6:abc123def456",
        "targetId": "/abs/path/src/app.ts#Person:3:789abc123def",
        "properties": { "role": "member" }
      }
    ]
  },

  "errors": [
    { "at": "ISO-8601 timestamp", "message": "Optional error or warning context", "severity": "warning" }
  ]
}
```

### Field semantics

- **schemaVersion** – increments on breaking changes.
- **state** – coarse progress indicator; `initialized` after scaffold, `scanned` once discovery runs, `indexed` after symbol/parsing persists, `error` if the last run failed.
- **languages** – set of language identifiers discovered during the latest successful run.
- **resources** – operational budgets honored by the indexer; `diskBudgetMb` drives pruning alerts.
- **persistence** – configured backends; `status` mirrors provisioning state.
- **acl** – mirrors enforced read/write roots to support audits.
- **parsers** – language-specific pipelines with current readiness.
- **artifacts** – absolute locations of generated assets.
- **lastCommand** – captures the most recent CLI invocation and options supplied.
- **lastScan** – summarises the latest file discovery run (inputs for subsequent symbol extraction).
- **symbolCount / relationCount** – aggregate totals for extracted symbols and inferred relations.
- **symbolErrors / symbolDiagnostics** – structured diagnostics for symbol extraction, including severity and optional ranges.
- **relations** – subset of relation edges captured during the latest run (primarily for debugging).
- **errors** – optional ring buffer of recent failures for diagnostics.

Future schema versions will extend this document with migration notes.
