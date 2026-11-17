---
'@wayapiteam/zapo-store-sqlite': patch
'@zapo-js/store-postgres': patch
'@zapo-js/store-mysql': patch
'@zapo-js/store-mongo': patch
'@zapo-js/store-redis': patch
---

Persist the existing auth `loginCounter` across store reloads. SQL providers add a nullable
counter column without rebuilding credential tables or rewriting stored keys. Legacy records
keep the core's existing fallback until the next successful login.

MySQL can resume the counter migration when its compatible column was committed before
the migration marker; incompatible preexisting columns still reject initialization.
