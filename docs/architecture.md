# Architecture

```mermaid
flowchart TB
  subgraph Collectors[Collection layer]
    VPS[VPS metrics]
    SEC[Security checks]
    WF[Workflow and error events]
    BK[Backup and restore checks]
  end

  Collectors --> API[Fastify observability API]
  API --> DB[(PostgreSQL monitoring schema)]
  UI[Static dashboard] --> API
  JOBS[Scheduler] --> Collectors
  API --> HEALTH[Health endpoint]
```

The public repository contains implementation examples and schema migrations. It does not contain customer names, production domains, real IP addresses, credentials, certificates, or operational exports.
