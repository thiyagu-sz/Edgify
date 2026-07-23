---
paths:
  - "lib/db/**/*.ts"
  - "app/api/**/*.ts"
---
# Database rules
No row-level security exists. Tenant isolation is application code.
- Every query function takes `userId` as its FIRST parameter
- Every SELECT/UPDATE/DELETE includes eq(table.userId, userId)
- No database calls outside lib/db/queries/
- Single-row lookups filter on BOTH id and userId
See docs/03-data-model.md.