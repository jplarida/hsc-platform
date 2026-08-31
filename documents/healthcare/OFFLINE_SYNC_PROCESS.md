# Offline Sync Process Diagrams

## Offline Sync Architecture Overview

### Sync Engine Architecture
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           OFFLINE SYNC SYSTEM                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        MOBILE APPLICATION                               │ │
│ │                                                                         │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │ │
│ │  │ UI Layer    │  │ State Mgmt  │  │ Sync Engine │  │ Local Database  │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  │• User       │  │• App State  │  │• WatermelonDB│  │• SQLite         │ │ │
│ │  │  interactions│  │• Sync State │  │• Conflict   │  │• Encrypted      │ │ │
│ │  │• Real-time  │  │• Queue Mgmt │  │  Resolution │  │• Indexed        │ │ │
│ │  │  updates    │  │• Error      │  │• Delta Sync │  │• Compressed     │ │ │
│ │  │• Offline    │  │  handling   │  │• Retry Logic│  │• Versioned      │ │ │
│ │  │  indicators │  │             │  │             │  │                 │ │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        SYNC MIDDLEWARE                                  │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                    SYNC SCHEDULER                               │   │ │
│ │  │                                                                 │   │ │
│ │  │  Network Status:                Sync Triggers:                 │   │ │
│ │  │  ┌─────────────┐                ┌─────────────────────────────┐ │   │ │
│ │  │  │• Online     │                │• Manual refresh             │ │   │ │
│ │  │  │• Offline    │                │• App foreground             │ │   │ │
│ │  │  │• Metered    │                │• Timer-based (every 5min)   │ │   │ │
│ │  │  │• WiFi only  │                │• Data change detected       │ │   │ │
│ │  │  │• Airplane   │                │• User action completed      │ │   │ │
│ │  │  │  mode       │                │• Push notification          │ │   │ │
│ │  │  └─────────────┘                └─────────────────────────────┘ │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        SERVER SYNC API                                  │ │
│ │                                                                         │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │ │
│ │  │ Sync        │  │ Conflict    │  │ Change      │  │ Push            │ │ │
│ │  │ Endpoint    │  │ Resolution  │  │ Detection   │  │ Notification    │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  │• Pull       │  │• Last Write │  │• Timestamps │  │• Real-time      │ │ │
│ │  │  changes    │  │  Wins       │  │• Version    │  │  updates        │ │ │
│ │  │• Push       │  │• Merge      │  │  numbers    │  │• Tenant-        │ │ │
│ │  │  changes    │  │  strategies │  │• Checksums  │  │  specific       │ │ │
│ │  │• Delta      │  │• User       │  │• Change     │  │• User-          │ │ │
│ │  │  computation│  │  resolution │  │  logs       │  │  specific       │ │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Sync Process Flow

### 1. Complete Sync Cycle
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SYNC PROCESS FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  START SYNC                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 1. Pre-Sync Checks                                                 │   │
│  │    ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐   │   │
│  │    │ Network     │    │ Battery     │    │ Storage Space       │   │   │
│  │    │ Available?  │    │ Sufficient? │    │ Available?          │   │   │
│  │    │             │    │             │    │                     │   │   │
│  │    │• WiFi/4G    │    │• >20% batt  │    │• >100MB free        │   │ │
│  │    │• Connection │    │• Not in     │    │• Cleanup old        │   │   │
│  │    │  stable     │    │  power save │    │  logs if needed     │   │   │
│  │    │• Server     │    │  mode       │    │                     │   │   │
│  │    │  reachable  │    │             │    │                     │   │   │
│  │    └─────────────┘    └─────────────┘    └─────────────────────┘   │   │
│  │           │                   │                     │               │   │
│  │           └───────────┬───────┴─────────────────────┘               │   │ │
│  │                       │                                             │   │
│  │                       ▼                                             │   │
│  │    ┌─────────────────────────────────────────────────────────────┐  │   │
│  │    │               PROCEED WITH SYNC                             │  │   │
│  │    └─────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 2. Fetch Server Changes (PULL)                                     │   │
│  │                                                                     │   │
│  │    Client Request:                                                  │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │ GET /api/sync/pull                                          │ │   │
│  │    │ Headers:                                                    │ │   │
│  │    │   Authorization: Bearer <jwt_token>                        │ │   │
│  │    │   X-Tenant-ID: <tenant_id>                                 │ │   │
│  │    │   Last-Sync-Timestamp: <timestamp>                         │ │   │
│  │    │ Body:                                                       │ │   │
│  │    │ {                                                           │ │   │
│  │    │   "last_sync": "2024-09-07T10:00:00Z",                    │ │   │
│  │    │   "device_id": "device_uuid",                              │ │   │
│  │    │   "tables": ["records", "files", "users"],                │ │   │
│  │    │   "checksums": {                                           │ │   │
│  │    │     "records": "abc123",                                   │ │   │
│  │    │     "files": "def456"                                      │ │   │
│  │    │   }                                                        │ │   │
│  │    │ }                                                           │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │    Server Response:                                                 │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │ {                                                           │ │   │
│  │    │   "success": true,                                          │ │   │
│  │    │   "changes": {                                              │ │   │
│  │    │     "records": {                                            │ │   │
│  │    │       "created": [                                          │ │   │
│  │    │         {                                                   │ │   │
│  │    │           "id": "record_1",                                 │ │   │
│  │    │           "data": {...},                                    │ │   │
│  │    │           "created_at": "2024-09-07T10:05:00Z",           │ │   │
│  │    │           "version": 1                                      │ │   │
│  │    │         }                                                   │ │   │
│  │    │       ],                                                    │ │   │
│  │    │       "updated": [                                          │ │   │
│  │    │         {                                                   │ │   │
│  │    │           "id": "record_2",                                 │ │   │
│  │    │           "data": {...},                                    │ │   │
│  │    │           "updated_at": "2024-09-07T10:03:00Z",           │ │   │
│  │    │           "version": 3                                      │ │   │
│  │    │         }                                                   │ │   │
│  │    │       ],                                                    │ │   │
│  │    │       "deleted": ["record_3"]                              │ │   │
│  │    │     }                                                       │ │   │
│  │    │   },                                                        │ │   │
│  │    │   "server_timestamp": "2024-09-07T10:10:00Z"              │ │   │
│  │    │ }                                                           │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 3. Conflict Detection & Resolution                                  │   │
│  │                                                                     │   │
│  │    For Each Changed Record:                                         │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │                                                             │ │   │
│  │    │  Local Version  │  Server Version  │   Resolution Action    │ │   │
│  │    │  ──────────────────────────────────────────────────────────│ │   │
│  │    │                                                             │ │   │
│  │    │  No local copy  │  Server has new  │   → Apply server      │ │   │
│  │    │                │  record          │     changes           │ │   │
│  │    │  ──────────────────────────────────────────────────────────│ │   │
│  │    │                                                             │ │   │
│  │    │  Local newer    │  Server older    │   → Keep local,       │ │   │
│  │    │  timestamp      │  timestamp       │     queue for push    │ │   │
│  │    │  ──────────────────────────────────────────────────────────│ │   │
│  │    │                                                             │ │   │
│  │    │  Same           │  Same            │   → No action         │ │   │
│  │    │  timestamp      │  timestamp       │     needed            │ │   │
│  │    │  ──────────────────────────────────────────────────────────│ │   │
│  │    │                                                             │ │   │
│  │    │  Both modified  │  Different       │   → CONFLICT!         │ │   │
│  │    │  since last     │  changes         │     Apply resolution  │ │   │
│  │    │  sync           │                  │     strategy          │ │   │
│  │    │                                                             │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 4. Apply Server Changes Locally                                     │   │
│  │                                                                     │   │
│  │    Transaction Start                                                │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │ BEGIN TRANSACTION                                           │ │   │
│  │    │                                                             │ │   │
│  │    │ For each server change:                                     │ │   │
│  │    │   1. Backup current local version                          │ │   │
│  │    │   2. Apply server change to local DB                       │ │   │
│  │    │   3. Update sync metadata                                  │ │   │
│  │    │   4. Trigger UI updates                                    │ │   │
│  │    │                                                             │ │   │
│  │    │ If any step fails:                                         │ │   │
│  │    │   → ROLLBACK TRANSACTION                                   │ │   │
│  │    │   → Log error and retry later                              │ │   │
│  │    │                                                             │ │   │
│  │    │ If all succeed:                                            │ │   │
│  │    │   → COMMIT TRANSACTION                                     │ │   │
│  │    │   → Update last_sync_timestamp                             │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 5. Push Local Changes (PUSH)                                       │   │
│  │                                                                     │   │
│  │    Collect Local Changes:                                           │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │ SELECT * FROM pending_changes                               │ │   │
│  │    │ WHERE sync_status = 'pending'                               │ │   │
│  │    │ ORDER BY created_at ASC                                     │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │    Client Push Request:                                             │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │ POST /api/sync/push                                         │ │   │
│  │    │ {                                                           │ │   │
│  │    │   "device_id": "device_uuid",                               │ │   │
│  │    │   "changes": [                                              │ │   │
│  │    │     {                                                       │ │   │
│  │    │       "id": "local_record_1",                               │ │   │
│  │    │       "operation": "create",                                │ │   │
│  │    │       "table": "records",                                   │ │   │
│  │    │       "data": {...},                                        │ │   │
│  │    │       "client_timestamp": "2024-09-07T10:08:00Z",         │ │   │
│  │    │       "local_version": 1                                    │ │   │
│  │    │     },                                                      │ │   │
│  │    │     {                                                       │ │   │
│  │    │       "id": "record_4",                                     │ │   │
│  │    │       "operation": "update",                                │ │   │
│  │    │       "table": "records",                                   │ │   │
│  │    │       "data": {...},                                        │ │   │
│  │    │       "client_timestamp": "2024-09-07T10:09:00Z",         │ │   │
│  │    │       "local_version": 2                                    │ │   │
│  │    │     }                                                       │ │   │
│  │    │   ]                                                         │ │   │
│  │    │ }                                                           │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 6. Server Processing & Response                                     │   │
│  │                                                                     │   │
│  │    Server Push Response:                                            │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │ {                                                           │ │   │
│  │    │   "success": true,                                          │ │   │
│  │    │   "processed_changes": [                                    │ │   │
│  │    │     {                                                       │ │   │
│  │    │       "client_id": "local_record_1",                       │ │   │
│  │    │       "server_id": "server_record_uuid",                   │ │   │
│  │    │       "status": "success",                                  │ │   │
│  │    │       "server_version": 1,                                  │ │   │
│  │    │       "server_timestamp": "2024-09-07T10:10:15Z"          │ │   │
│  │    │     },                                                      │ │   │
│  │    │     {                                                       │ │   │
│  │    │       "client_id": "record_4",                             │ │   │
│  │    │       "server_id": "record_4",                             │ │   │
│  │    │       "status": "conflict",                                │ │   │
│  │    │       "conflict_resolution": "server_wins",                │ │   │
│  │    │       "server_data": {...},                                │ │   │
│  │    │       "server_version": 3                                   │ │   │
│  │    │     }                                                       │ │   │
│  │    │   ],                                                        │ │   │
│  │    │   "server_timestamp": "2024-09-07T10:10:15Z"              │ │   │
│  │    │ }                                                           │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 7. Update Local State & Cleanup                                    │   │
│  │                                                                     │   │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │
│  │    │ For each successfully processed change:                     │ │   │
│  │    │   1. Update local record with server ID/version             │ │   │
│  │    │   2. Mark change as 'synced' in pending_changes             │ │   │
│  │    │   3. Remove from local sync queue                           │ │   │
│  │    │                                                             │ │   │
│  │    │ For each conflict:                                          │ │   │
│  │    │   1. Apply server resolution                                │ │   │
│  │    │   2. Notify user if manual resolution needed               │ │   │
│  │    │   3. Update local record                                    │ │   │
│  │    │                                                             │ │   │
│  │    │ For each failed change:                                     │ │   │
│  │    │   1. Mark as 'failed' with error details                   │ │   │
│  │    │   2. Schedule retry with exponential backoff               │ │   │
│  │    │   3. Alert user if max retries exceeded                    │ │   │
│  │    │                                                             │ │   │
│  │    │ Update sync metadata:                                       │ │   │
│  │    │   • last_successful_sync = server_timestamp                │ │   │
│  │    │   • sync_status = 'completed'                              │ │   │
│  │    │   • next_sync_schedule = now + sync_interval               │ │   │
│  │    └─────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ SYNC COMPLETE                                                       │   │
│  │                                                                     │   │
│  │ ✅ UI updated with latest data                                      │   │
│  │ ✅ User notified of sync completion                                 │   │
│  │ ✅ Background sync scheduled for next interval                      │   │
│  │ ✅ Metrics logged for performance monitoring                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Conflict Resolution Strategies

### 1. Conflict Resolution Decision Tree
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CONFLICT RESOLUTION                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONFLICT DETECTED                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Local Version ≠ Server Version                                      │   │
│  │ Both modified since last sync                                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      ANALYZE CONFLICT TYPE                          │   │
│  │                                                                     │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │   │
│  │  │ Field-Level     │  │ Record-Level    │  │ Structural          │  │   │
│  │  │ Conflict        │  │ Conflict        │  │ Conflict            │  │   │
│  │  │                 │  │                 │  │                     │  │   │
│  │  │• Different vals │  │• Same record    │  │• Schema changes     │  │   │
│  │  │  for same field │  │  modified in    │  │• Table structure    │  │   │
│  │  │• Can be merged  │  │  different ways │  │• New fields added   │  │   │
│  │  │  automatically  │  │• Complex merge  │  │• Requires migration │  │   │
│  │  │                 │  │  required       │  │                     │  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │   │
│  │           │                     │                     │              │   │
│  │           ▼                     ▼                     ▼              │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │   │
│  │  │ AUTO MERGE      │  │ STRATEGY        │  │ MANUAL RESOLUTION   │  │   │
│  │  │                 │  │ RESOLUTION      │  │                     │  │   │
│  │  │• Timestamp wins │  │                 │  │• Developer          │  │   │
│  │  │• User priority  │  │• Last write     │  │  intervention       │  │   │
│  │  │• Field merge    │  │  wins           │  │• Schema migration   │  │   │
│  │  │• Append values  │  │• Server wins    │  │• Data loss          │  │   │
│  │  │                 │  │• Client wins    │  │  prevention         │  │   │
│  │  │                 │  │• User decides   │  │                     │  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      RESOLUTION ALGORITHMS                          │   │
│  │                                                                     │   │
│  │  1. TIMESTAMP-BASED (Last Write Wins):                             │   │
│  │     ┌─────────────────────────────────────────────────────────┐   │   │
│  │     │ if (server_timestamp > local_timestamp) {              │   │   │
│  │     │     return server_version;                              │   │   │
│  │     │ } else {                                                │   │   │
│  │     │     return local_version;                               │   │   │
│  │     │ }                                                       │   │   │
│  │     └─────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │  2. FIELD-LEVEL MERGE:                                              │   │
│  │     ┌─────────────────────────────────────────────────────────┐   │   │
│  │     │ merged_record = {};                                     │   │   │
│  │     │ for (field in all_fields) {                            │   │   │
│  │     │     if (local[field] != server[field]) {               │   │   │
│  │     │         if (local[field + '_timestamp'] >              │   │   │
│  │     │             server[field + '_timestamp']) {            │   │   │
│  │     │             merged_record[field] = local[field];       │   │   │
│  │     │         } else {                                        │   │   │
│  │     │             merged_record[field] = server[field];      │   │   │
│  │     │         }                                               │   │   │
│  │     │     }                                                   │   │   │
│  │     │ }                                                       │   │   │
│  │     └─────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │  3. USER PREFERENCE RESOLUTION:                                     │   │
│  │     ┌─────────────────────────────────────────────────────────┐   │   │
│  │     │ // Show conflict resolution UI                          │   │   │
│  │     │ showConflictDialog({                                    │   │   │
│  │     │     local_version: local_data,                          │   │   │
│  │     │     server_version: server_data,                        │   │   │
│  │     │     onResolve: (resolved_data) => {                     │   │   │
│  │     │         applyResolution(resolved_data);                 │   │   │
│  │     │         markAsResolved(record_id);                      │   │   │
│  │     │     }                                                   │   │   │
│  │     │ });                                                     │   │   │
│  │     └─────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │  4. BUSINESS RULE-BASED:                                            │   │
│  │     ┌─────────────────────────────────────────────────────────┐   │   │
│  │     │ switch (record.type) {                                  │   │   │
│  │     │     case 'patient_record':                              │   │   │
│  │     │         // Medical data: always prefer server          │   │   │
│  │     │         return server_version;                          │   │   │
│  │     │     case 'user_preference':                             │   │   │
│  │     │         // UI prefs: always prefer local               │   │   │
│  │     │         return local_version;                           │   │   │
│  │     │     case 'inventory':                                   │   │   │
│  │     │         // Sum quantities, latest timestamp for other  │   │   │
│  │     │         return merge_inventory(local, server);          │   │   │
│  │     │     default:                                            │   │   │
│  │     │         return timestamp_resolution(local, server);    │   │   │
│  │     │ }                                                       │   │   │
│  │     └─────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Error Handling & Recovery

### 1. Sync Error Recovery Flow
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SYNC ERROR HANDLING                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SYNC ERROR DETECTED                                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       ERROR CLASSIFICATION                          │   │
│  │                                                                     │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │   │
│  │  │ Network Errors  │  │ Server Errors   │  │ Client Errors       │  │   │
│  │  │                 │  │                 │  │                     │  │   │
│  │  │• Connection     │  │• 5xx responses  │  │• Local DB errors    │  │   │
│  │  │  timeout        │  │• Rate limiting  │  │• Storage full       │  │   │
│  │  │• DNS failure    │  │• Server         │  │• App crashes        │  │   │
│  │  │• Network        │  │  maintenance    │  │• Permission denied  │  │   │
│  │  │  unreachable    │  │• Database       │  │• Invalid data       │  │   │
│  │  │• SSL errors     │  │  deadlocks      │  │                     │  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │   │
│  │           │                     │                     │              │   │
│  │           ▼                     ▼                     ▼              │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │   │
│  │  │ RETRY WITH      │  │ EXPONENTIAL     │  │ IMMEDIATE FAILURE   │  │   │
│  │  │ BACKOFF         │  │ BACKOFF         │  │                     │  │   │
│  │  │                 │  │                 │  │• Log error          │  │   │
│  │  │• Immediate      │  │• 1s, 2s, 4s,    │  │• Show user message  │  │   │
│  │  │• 5s, 10s, 30s   │  │  8s, 16s, 32s   │  │• Manual retry       │  │   │
│  │  │• Max 5 retries  │  │• Max 6 retries   │  │  required           │  │   │
│  │  │                 │  │                 │  │                     │  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       RECOVERY STRATEGIES                           │   │
│  │                                                                     │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                    PARTIAL SYNC RECOVERY                   │   │   │
│  │  │                                                             │   │   │
│  │  │  If sync fails midway:                                     │   │   │
│  │  │  1. Identify last successful sync point                    │   │   │
│  │  │  2. Rollback any incomplete transactions                   │   │   │
│  │  │  3. Resume from last checkpoint                            │   │   │
│  │  │  4. Skip already processed changes                         │   │   │
│  │  │                                                             │   │   │
│  │  │  Checkpoint Data:                                          │   │   │
│  │  │  {                                                          │   │   │
│  │  │    "sync_id": "uuid",                                       │   │   │
│  │  │    "phase": "pull_complete",                                │   │   │
│  │  │    "processed_changes": 150,                                │   │   │
│  │  │    "pending_changes": 25,                                   │   │   │
│  │  │    "last_server_timestamp": "2024-09-07T10:05:30Z",       │   │   │
│  │  │    "checkpoint_timestamp": "2024-09-07T10:06:45Z"         │   │   │
│  │  │  }                                                          │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                    DATA INTEGRITY RECOVERY                 │   │   │
│  │  │                                                             │   │   │
│  │  │  Data Corruption Detected:                                 │   │   │
│  │  │  1. Stop all sync operations                               │   │   │
│  │  │  2. Create local database backup                           │   │   │
│  │  │  3. Validate data integrity with checksums                 │   │   │
│  │  │  4. Compare with server state                              │   │   │
│  │  │  5. Repair corrupted records                               │   │   │
│  │  │  6. Re-sync from clean state if needed                     │   │   │
│  │  │                                                             │   │   │
│  │  │  Recovery Options:                                          │   │   │
│  │  │  • Automatic repair (minor corruption)                     │   │   │
│  │  │  • User-guided recovery (data conflicts)                   │   │   │
│  │  │  • Full re-sync (major corruption)                         │   │   │
│  │  │  • Restore from backup (critical failure)                 │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                    QUEUE MANAGEMENT                        │   │   │
│  │  │                                                             │   │   │
│  │  │  Failed Change Handling:                                   │   │   │
│  │  │  1. Mark change as 'failed' in queue                       │   │   │
│  │  │  2. Increment retry counter                                │   │   │
│  │  │  3. Calculate next retry time                              │   │   │
│  │  │  4. Move to failed queue after max retries                │   │   │
│  │  │                                                             │   │   │
│  │  │  Queue States:                                             │   │   │
│  │  │  • pending → processing → success/failed                  │   │   │
│  │  │  • failed → retry_queue (with backoff)                    │   │   │
│  │  │  • failed_permanent → manual_review_queue                 │   │   │
│  │  │                                                             │   │   │
│  │  │  Cleanup Strategy:                                         │   │   │
│  │  │  • Remove successful changes after 7 days                 │   │   │
│  │  │  • Archive failed changes after 30 days                  │   │   │
│  │  │  • Alert admin for permanent failures                     │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```