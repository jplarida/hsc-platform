# API Architecture Diagrams

## RESTful API Architecture Overview

### API Gateway & Service Architecture
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                           CLIENT LAYER                                  │ │
│ │                                                                         │ │
│ │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │ │
│ │  │ Web App         │    │ Mobile App      │    │ Third-party         │  │ │
│ │  │ (React)         │    │ (React+Ionic)   │    │ Integrations        │  │ │
│ │  │                 │    │                 │    │                     │  │ │
│ │  │• HTTP/HTTPS     │    │• HTTP/HTTPS     │    │• Webhook clients    │  │ │
│ │  │• WebSocket      │    │• WebSocket      │    │• API consumers      │  │ │
│ │  │• JSON payloads  │    │• JSON payloads  │    │• External services  │  │ │
│ │  │• Bearer tokens  │    │• Bearer tokens  │    │• API keys           │  │ │
│ │  └─────────────────┘    └─────────────────┘    └─────────────────────┘  │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                            CDN LAYER                                    │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                     CLOUDFLARE / CLOUDFRONT                     │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ Static      │  │ API         │  │ Security    │             │   │ │
│ │  │  │ Assets      │  │ Caching     │  │ Features    │             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• JS bundles │  │• GET        │  │• DDoS       │             │   │ │
│ │  │  │• CSS files  │  │  responses  │  │  protection │             │   │ │
│ │  │  │• Images     │  │• Config     │  │• WAF rules  │             │   │ │
│ │  │  │• Fonts      │  │  data       │  │• Bot        │             │   │ │
│ │  │  │             │  │• Public     │  │  mitigation │             │   │ │
│ │  │  │             │  │  endpoints  │  │• Geographic │             │   │ │
│ │  │  │             │  │             │  │  filtering  │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                         LOAD BALANCER                                   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                 AWS ALB / NGINX / HAPROXY                       │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ SSL         │  │ Health      │  │ Traffic     │             │   │ │
│ │  │  │ Termination │  │ Checks      │  │ Distribution│             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• TLS 1.3    │  │• /health    │  │• Round      │             │   │ │
│ │  │  │• Cert mgmt  │  │• /metrics   │  │  robin      │             │   │ │
│ │  │  │• HSTS       │  │• /ready     │  │• Weighted   │             │   │ │
│ │  │  │• Perfect    │  │• Auto       │  │• Sticky     │             │   │ │
│ │  │  │  forward    │  │  failover   │  │  sessions   │             │   │ │
│ │  │  │  secrecy    │  │             │  │             │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                          API GATEWAY                                    │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                    REQUEST PROCESSING PIPELINE                  │   │ │
│ │  │                                                                 │   │ │
│ │  │  Incoming Request                                               │   │ │
│ │  │  ┌─────────────────┐                                           │   │ │
│ │  │  │ POST /api/v1/   │                                           │   │ │
│ │  │  │ records         │                                           │   │ │
│ │  │  │ ──────────────  │                                           │   │ │
│ │  │  │ Authorization:  │                                           │   │ │
│ │  │  │ Bearer <token>  │                                           │   │ │
│ │  │  │ X-Tenant-ID:    │                                           │   │ │
│ │  │  │ healthcare-plus │                                           │   │ │
│ │  │  │ Content-Type:   │                                           │   │ │
│ │  │  │ application/    │                                           │   │ │
│ │  │  │ json            │                                           │   │ │
│ │  │  └─────────────────┘                                           │   │ │
│ │  │           │                                                     │   │ │
│ │  │           ▼                                                     │   │ │
│ │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │   │ │
│ │  │  │ 1. Rate         │  │ 2. Tenant       │  │ 3. Auth         │ │   │ │
│ │  │  │    Limiting     │  │    Resolution   │  │    Validation   │ │   │ │
│ │  │  │                 │  │                 │  │                 │ │   │ │
│ │  │  │• Per tenant     │  │• Extract from   │  │• JWT verify     │ │   │ │
│ │  │  │• Per user       │  │  header/domain  │  │• Token exp      │ │   │ │
│ │  │  │• Per endpoint   │  │• Validate       │  │• Refresh        │ │   │ │
│ │  │  │• Sliding        │  │  exists         │  │  if needed      │ │   │ │
│ │  │  │  window         │  │• Set context    │  │• MFA check      │ │   │ │
│ │  │  │                 │  │                 │  │                 │ │   │ │
│ │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘ │   │ │
│ │  │           │                     │                     │         │   │ │
│ │  │           └─────────────────────┼─────────────────────┘         │   │ │
│ │  │                               │                                 │   │ │
│ │  │                               ▼                                 │   │ │
│ │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │   │ │
│ │  │  │ 4. Request      │  │ 5. Input        │  │ 6. Route        │ │   │ │
│ │  │  │    Validation   │  │    Sanitization │  │    Resolution   │ │   │ │
│ │  │  │                 │  │                 │  │                 │ │   │ │
│ │  │  │• Content-Type   │  │• XSS            │  │• Path matching  │ │   │ │
│ │  │  │• Method check   │  │  prevention     │  │• Version        │ │   │ │
│ │  │  │• Size limits    │  │• SQL injection  │  │  routing        │ │   │ │
│ │  │  │• Schema valid   │  │  prevention     │  │• Service        │ │   │ │
│ │  │  │                 │  │• Input          │  │  discovery      │ │   │ │
│ │  │  │                 │  │  validation     │  │                 │ │   │ │
│ │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘ │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                      MICROSERVICES LAYER                               │ │
│ │                                                                         │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │ │
│ │  │ Core API    │  │ Auth        │  │ Sync        │  │ File Service    │ │ │
│ │  │ Service     │  │ Service     │  │ Service     │  │                 │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  │• CRUD ops   │  │• Login/     │  │• Offline    │  │• Upload/        │ │ │
│ │  │• Business   │  │  logout     │  │  sync       │  │  Download       │ │ │
│ │  │  logic      │  │• JWT mgmt   │  │• Conflict   │  │• Virus scan     │ │ │
│ │  │• Validation │  │• Session    │  │  resolution │  │• Resize/        │ │ │
│ │  │• Workflows  │  │  handling   │  │• Delta      │  │  compress       │ │ │
│ │  │             │  │• MFA        │  │  computation│  │• CDN dist       │ │ │
│ │  │             │  │• Password   │  │             │  │                 │ │ │
│ │  │             │  │  reset      │  │             │  │                 │ │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │ │
│ │        │                │                │                │             │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │ │
│ │  │ Notification│  │ Analytics   │  │ Integration │  │ Admin Service   │ │ │
│ │  │ Service     │  │ Service     │  │ Service     │  │                 │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  │• Email/SMS  │  │• Usage      │  │• Webhooks   │  │• Tenant mgmt    │ │ │
│ │  │• Push       │  │  tracking   │  │• Third-     │  │• User mgmt      │ │ │
│ │  │  notifications│ │• Metrics    │  │  party APIs │  │• System config │ │ │
│ │  │• Real-time  │  │• Reports    │  │• API keys   │  │• Monitoring     │ │ │
│ │  │  updates    │  │• Dashboards │  │• OAuth      │  │• Health checks  │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                           DATA LAYER                                    │ │
│ │                                                                         │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │ │
│ │  │ PostgreSQL  │  │ Redis       │  │ Elasticsearch│  │ File Storage    │ │ │
│ │  │ Primary DB  │  │ Cache/Queue │  │ Search Index │  │ (S3/Azure)      │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  │• Multi-     │  │• Session    │  │• Full-text  │  │• Encrypted      │ │ │
│ │  │  tenant     │  │  storage    │  │  search     │  │• Versioned      │ │ │
│ │  │• Row-level  │  │• Job queue  │  │• Analytics  │  │• CDN            │ │ │
│ │  │  security   │  │• Pub/sub    │  │• Logging    │  │  distributed    │ │ │
│ │  │• Audit      │  │• Rate       │  │             │  │• Lifecycle      │ │ │
│ │  │  logging    │  │  limiting   │  │             │  │  management     │ │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## API Endpoint Structure & Organization

### 1. RESTful Endpoint Design
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API ENDPOINTS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Base URL: https://api.allguds.com/v1                                       │
│  Tenant URLs: https://healthcare-plus.allguds.com/api/v1                    │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        AUTHENTICATION ENDPOINTS                         │ │
│ │                                                                         │ │
│ │  POST   /auth/login                                                     │ │
│ │  POST   /auth/logout                                                    │ │
│ │  POST   /auth/refresh                                                   │ │
│ │  POST   /auth/forgot-password                                           │ │
│ │  POST   /auth/reset-password                                            │ │
│ │  POST   /auth/verify-email                                              │ │
│ │  POST   /auth/setup-mfa                                                 │ │
│ │  POST   /auth/verify-mfa                                                │ │
│ │                                                                         │ │
│ │  Request Example:                                                       │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ POST /auth/login                                                │   │ │
│ │  │ Content-Type: application/json                                  │   │ │
│ │  │                                                                 │   │ │
│ │  │ {                                                               │   │ │
│ │  │   "email": "admin@healthcare-plus.com",                        │   │ │
│ │  │   "password": "securePassword123!",                            │   │ │
│ │  │   "tenant_domain": "healthcare-plus",                          │   │ │
│ │  │   "mfa_token": "123456",                                        │   │ │
│ │  │   "device_info": {                                              │   │ │
│ │  │     "device_id": "device_uuid",                                 │   │ │
│ │  │     "device_name": "iPhone 15 Pro",                            │   │ │
│ │  │     "os_version": "iOS 17.1",                                   │   │ │
│ │  │     "app_version": "2.1.0"                                      │   │ │
│ │  │   }                                                             │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  Response Example:                                                      │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ HTTP/1.1 200 OK                                                 │   │ │
│ │  │ Content-Type: application/json                                  │   │ │
│ │  │                                                                 │   │ │
│ │  │ {                                                               │   │ │
│ │  │   "success": true,                                              │   │ │
│ │  │   "data": {                                                     │   │ │
│ │  │     "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",│   │ │
│ │  │     "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",│   │ │
│ │  │     "expires_in": 3600,                                         │   │ │
│ │  │     "token_type": "Bearer",                                     │   │ │
│ │  │     "user": {                                                   │   │ │
│ │  │       "id": "user_uuid",                                        │   │ │
│ │  │       "email": "admin@healthcare-plus.com",                    │   │ │
│ │  │       "name": "Dr. John Smith",                                 │   │ │
│ │  │       "roles": ["admin", "user"],                              │   │ │
│ │  │       "permissions": {...},                                     │   │ │
│ │  │       "tenant": {                                               │   │ │
│ │  │         "id": "tenant_uuid",                                    │   │ │
│ │  │         "name": "Healthcare Plus",                             │   │ │
│ │  │         "subdomain": "healthcare-plus",                        │   │ │
│ │  │         "plan": "professional",                                 │   │ │
│ │  │         "features": {...}                                       │   │ │
│ │  │       }                                                         │   │ │
│ │  │     }                                                           │   │ │
│ │  │   },                                                            │   │ │
│ │  │   "meta": {                                                     │   │ │
│ │  │     "request_id": "req_uuid",                                   │   │ │
│ │  │     "timestamp": "2024-09-07T10:15:30Z"                       │   │ │
│ │  │   }                                                             │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                         CORE DATA ENDPOINTS                             │ │
│ │                                                                         │ │
│ │  Records (Generic Data):                                                │ │
│ │  GET    /records                     # List with filtering/pagination   │ │
│ │  POST   /records                     # Create new record                │ │
│ │  GET    /records/{id}                # Get specific record              │ │
│ │  PUT    /records/{id}                # Update record (full)             │ │
│ │  PATCH  /records/{id}                # Update record (partial)          │ │
│ │  DELETE /records/{id}                # Delete record (soft delete)      │ │
│ │                                                                         │ │
│ │  Files & Attachments:                                                   │ │
│ │  GET    /files                       # List files                       │ │
│ │  POST   /files                       # Upload new file                  │ │
│ │  GET    /files/{id}                  # Get file metadata               │ │
│ │  GET    /files/{id}/download         # Download file content           │ │
│ │  DELETE /files/{id}                  # Delete file                      │ │
│ │  POST   /files/bulk-upload           # Bulk file upload                │ │
│ │                                                                         │ │
│ │  Forms & Workflows:                                                     │ │
│ │  GET    /forms                       # List available forms             │ │
│ │  POST   /forms                       # Create custom form               │ │
│ │  GET    /forms/{id}                  # Get form schema                  │ │
│ │  GET    /workflows                   # List workflows                   │ │
│ │  POST   /workflows/{id}/advance      # Advance workflow state          │ │
│ │                                                                         │ │
│ │  Search & Filtering:                                                    │ │
│ │  GET    /search?q={query}            # Full-text search                │ │
│ │  POST   /search/advanced             # Advanced search with filters    │ │
│ │  GET    /records?filter={conditions} # Filtered record listing         │ │
│ │                                                                         │ │
│ │  Query Examples:                                                        │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ GET /records?type=patient&status=active&limit=20&offset=40      │   │ │
│ │  │ GET /records?created_after=2024-01-01&sort=created_at:desc      │   │ │
│ │  │ GET /search?q=john+smith&type=patient&fields=name,email         │   │ │
│ │  │ POST /search/advanced                                           │   │ │
│ │  │ {                                                               │   │ │
│ │  │   "filters": {                                                  │   │ │
│ │  │     "and": [                                                    │   │ │
│ │  │       {"field": "type", "op": "eq", "value": "patient"},       │   │ │
│ │  │       {"field": "age", "op": "gte", "value": 18},              │   │ │
│ │  │       {"field": "city", "op": "in", "value": ["NY", "LA"]}     │   │ │
│ │  │     ]                                                           │   │ │
│ │  │   },                                                            │   │ │
│ │  │   "sort": [{"field": "created_at", "order": "desc"}],          │   │ │
│ │  │   "limit": 50,                                                  │   │ │
│ │  │   "offset": 0                                                   │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                          SYNC ENDPOINTS                                 │ │
│ │                                                                         │ │
│ │  Offline Synchronization:                                               │ │
│ │  POST   /sync/pull                   # Get server changes               │ │
│ │  POST   /sync/push                   # Send local changes               │ │
│ │  POST   /sync/resolve-conflict       # Handle conflicts                 │ │
│ │  GET    /sync/status                 # Get sync status                  │ │
│ │  POST   /sync/reset                  # Reset sync state (admin)         │ │
│ │                                                                         │ │
│ │  Real-time Updates:                                                     │ │
│ │  WS     /ws/updates                  # WebSocket for real-time data     │ │
│ │  POST   /notifications/subscribe     # Subscribe to push notifications  │ │
│ │  DELETE /notifications/unsubscribe   # Unsubscribe from notifications   │ │
│ │                                                                         │ │
│ │  Sync Request Example:                                                  │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ POST /sync/pull                                                 │   │ │
│ │  │ Authorization: Bearer <token>                                   │   │ │
│ │  │ X-Tenant-ID: healthcare-plus                                    │   │ │
│ │  │                                                                 │   │ │
│ │  │ {                                                               │   │ │
│ │  │   "device_id": "device_uuid",                                   │   │ │
│ │  │   "last_sync": "2024-09-07T09:00:00Z",                        │   │ │
│ │  │   "tables": ["records", "files"],                              │   │ │
│ │  │   "checksums": {                                                │   │ │
│ │  │     "records": "abc123hash",                                    │   │ │
│ │  │     "files": "def456hash"                                       │   │ │
│ │  │   },                                                            │   │ │
│ │  │   "limit": 100                                                  │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        ADMIN & TENANT ENDPOINTS                         │ │
│ │                                                                         │ │
│ │  Tenant Management:                                                     │ │
│ │  GET    /tenant/config               # Get tenant configuration         │ │
│ │  PATCH  /tenant/config               # Update tenant configuration      │ │
│ │  GET    /tenant/usage                # Get usage statistics             │ │
│ │  GET    /tenant/billing              # Get billing information          │ │
│ │                                                                         │ │
│ │  User Management:                                                       │ │
│ │  GET    /users                       # List tenant users                │ │
│ │  POST   /users                       # Invite new user                  │ │
│ │  GET    /users/{id}                  # Get user details                 │ │
│ │  PATCH  /users/{id}                  # Update user                      │ │
│ │  DELETE /users/{id}                  # Deactivate user                  │ │
│ │  POST   /users/{id}/reset-password   # Reset user password              │ │
│ │                                                                         │ │
│ │  Analytics & Reporting:                                                 │ │
│ │  GET    /analytics/usage             # Usage analytics                  │ │
│ │  GET    /analytics/performance       # Performance metrics              │ │
│ │  POST   /reports/generate            # Generate custom report           │ │
│ │  GET    /reports/{id}                # Get generated report             │ │
│ │  GET    /audit-logs                  # Access audit logs                │ │
│ │                                                                         │ │
│ │  Integration & Webhooks:                                                │ │
│ │  GET    /integrations                # List available integrations      │ │
│ │  POST   /integrations/{type}         # Configure integration            │ │
│ │  GET    /webhooks                    # List webhooks                    │ │
│ │  POST   /webhooks                    # Create webhook                   │ │
│ │  PUT    /webhooks/{id}               # Update webhook                   │ │
│ │  DELETE /webhooks/{id}               # Delete webhook                   │ │
│ │  POST   /webhooks/{id}/test          # Test webhook                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## API Rate Limiting & Throttling

### 1. Rate Limiting Strategy
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            RATE LIMITING SYSTEM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                          RATE LIMIT TIERS                              │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                        FREE TIER                               │   │   │
│ │  │ • 1,000 requests/hour per tenant                               │   │   │
│ │  │ • 100 requests/minute per user                                 │   │   │
│ │  │ • 10 concurrent connections                                    │   │   │
│ │  │ • 50 MB file upload limit                                      │   │   │
│ │  │ • 1 webhook endpoint                                           │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                       BASIC TIER                               │   │   │
│ │  │ • 10,000 requests/hour per tenant                              │   │   │
│ │  │ • 500 requests/minute per user                                 │   │   │
│ │  │ • 50 concurrent connections                                    │   │   │
│ │  │ • 200 MB file upload limit                                     │   │   │
│ │  │ • 5 webhook endpoints                                          │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                    PROFESSIONAL TIER                           │   │   │
│ │  │ • 100,000 requests/hour per tenant                             │   │   │
│ │  │ • 2,000 requests/minute per user                               │   │   │
│ │  │ • 200 concurrent connections                                   │   │   │
│ │  │ • 1 GB file upload limit                                       │   │   │
│ │  │ • 20 webhook endpoints                                         │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                     ENTERPRISE TIER                            │   │   │
│ │  │ • 1,000,000 requests/hour per tenant                           │   │   │
│ │  │ • 10,000 requests/minute per user                              │   │   │
│ │  │ • 1,000 concurrent connections                                 │   │   │
│ │  │ • 5 GB file upload limit                                       │   │   │
│ │  │ • Unlimited webhook endpoints                                  │   │   │
│ │  │ • Custom rate limits available                                 │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                      ENDPOINT-SPECIFIC LIMITS                          │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ Authentication Endpoints:                                       │   │   │
│ │  │ • /auth/login: 10 attempts/5 minutes per IP                    │   │   │
│ │  │ • /auth/forgot-password: 3 requests/hour per email             │   │   │
│ │  │ • /auth/refresh: 100 requests/hour per token                   │   │   │
│ │  │ • /auth/verify-mfa: 10 attempts/5 minutes per session          │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ Heavy Operation Endpoints:                                      │   │   │
│ │  │ • /files POST: 50 uploads/hour per user                        │   │   │
│ │  │ • /search POST: 1,000 searches/hour per tenant                 │   │   │
│ │  │ • /reports/generate: 10 reports/hour per tenant                │   │   │
│ │  │ • /sync/pull: 1 request/5 seconds per device                   │   │   │
│ │  │ • /sync/push: 1 request/2 seconds per device                   │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ Bulk Operation Endpoints:                                       │   │   │
│ │  │ • /records (bulk create): 100 records/request max              │   │   │
│ │  │ • /files/bulk-upload: 20 files/request max                     │   │   │
│ │  │ • Export operations: 1 request/10 minutes per tenant           │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                      RATE LIMITING IMPLEMENTATION                       │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                      SLIDING WINDOW                             │   │   │
│ │  │                                                                 │   │   │
│ │  │  Redis-based Implementation:                                    │   │   │
│ │  │  ┌─────────────────────────────────────────────────────────┐   │   │   │
│ │  │  │ function checkRateLimit(key, limit, window) {           │   │   │   │
│ │  │  │   const now = Date.now();                               │   │   │   │
│ │  │  │   const pipeline = redis.pipeline();                    │   │   │   │
│ │  │  │                                                         │   │   │   │
│ │  │  │   // Remove old entries                                 │   │   │   │
│ │  │  │   pipeline.zremrangebyscore(key, 0, now - window);     │   │   │   │
│ │  │  │                                                         │   │   │   │
│ │  │  │   // Count current entries                              │   │   │   │
│ │  │  │   pipeline.zcard(key);                                  │   │   │   │
│ │  │  │                                                         │   │   │   │
│ │  │  │   // Add current request                                │   │   │   │
│ │  │  │   pipeline.zadd(key, now, `${now}-${Math.random()}`);   │   │   │   │
│ │  │  │                                                         │   │   │   │
│ │  │  │   // Set expiration                                     │   │   │   │
│ │  │  │   pipeline.expire(key, Math.ceil(window / 1000));       │   │   │   │
│ │  │  │                                                         │   │   │   │
│ │  │  │   const results = await pipeline.exec();               │   │   │   │
│ │  │  │   const count = results[1][1];                          │   │   │   │
│ │  │  │                                                         │   │   │   │
│ │  │  │   return {                                              │   │   │   │
│ │  │  │     allowed: count <= limit,                           │   │   │   │
│ │  │  │     count: count,                                       │   │   │   │
│ │  │  │     remaining: Math.max(0, limit - count),             │   │   │   │
│ │  │  │     resetTime: now + window                            │   │   │   │
│ │  │  │   };                                                    │   │   │   │
│ │  │  │ }                                                       │   │   │   │
│ │  │  └─────────────────────────────────────────────────────────┘   │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                     RESPONSE HEADERS                            │   │   │
│ │  │                                                                 │   │   │
│ │  │  Rate Limit Headers (included in all responses):               │   │   │
│ │  │  ┌─────────────────────────────────────────────────────────┐   │   │   │
│ │  │  │ X-RateLimit-Limit: 1000                                 │   │   │   │
│ │  │  │ X-RateLimit-Remaining: 856                              │   │   │   │
│ │  │  │ X-RateLimit-Reset: 1694123456                           │   │   │   │
│ │  │  │ X-RateLimit-Window: 3600                                │   │   │   │
│ │  │  │                                                         │   │   │   │
│ │  │  │ When rate limit exceeded (429 Too Many Requests):      │   │   │   │
│ │  │  │ {                                                       │   │   │   │
│ │  │  │   "success": false,                                     │   │   │   │
│ │  │  │   "error": {                                            │   │   │   │
│ │  │  │     "code": "RATE_LIMIT_EXCEEDED",                     │   │   │   │
│ │  │  │     "message": "Too many requests",                    │   │   │   │
│ │  │  │     "details": {                                        │   │   │   │
│ │  │  │       "limit": 1000,                                   │   │   │   │
│ │  │  │       "window": 3600,                                  │   │   │   │
│ │  │  │       "reset_at": "2024-09-07T11:15:30Z",             │   │   │   │
│ │  │  │       "retry_after": 900                               │   │   │   │
│ │  │  │     }                                                   │   │   │   │
│ │  │  │   },                                                    │   │   │   │
│ │  │  │   "meta": {                                             │   │   │   │
│ │  │  │     "request_id": "req_uuid",                           │   │   │   │
│ │  │  │     "timestamp": "2024-09-07T10:30:00Z"               │   │   │   │
│ │  │  │   }                                                     │   │   │   │
│ │  │  │ }                                                       │   │   │   │
│ │  │  └─────────────────────────────────────────────────────────┘   │   │   │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Error Handling & Response Standards

### 1. Standardized Error Responses
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ERROR HANDLING SYSTEM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                         HTTP STATUS CODES                              │ │
│ │                                                                         │ │
│ │  Success Codes:                                                         │ │
│ │  • 200 OK           - Successful GET, PUT, PATCH                        │ │
│ │  • 201 Created      - Successful POST (resource created)               │ │
│ │  • 202 Accepted     - Async operation started                          │ │
│ │  • 204 No Content   - Successful DELETE                                │ │
│ │                                                                         │ │
│ │  Client Error Codes:                                                    │ │
│ │  • 400 Bad Request  - Invalid request syntax/data                      │ │
│ │  • 401 Unauthorized - Authentication required/failed                   │ │
│ │  • 403 Forbidden    - Permission denied                                │ │
│ │  • 404 Not Found    - Resource doesn't exist                           │ │
│ │  • 409 Conflict     - Data conflict (e.g., duplicate)                  │ │
│ │  • 422 Unprocessable Entity - Validation errors                        │ │
│ │  • 429 Too Many Requests - Rate limit exceeded                         │ │
│ │                                                                         │ │
│ │  Server Error Codes:                                                    │ │
│ │  • 500 Internal Server Error - Unexpected server error                 │ │
│ │  • 502 Bad Gateway  - Upstream service error                           │ │
│ │  • 503 Service Unavailable - Maintenance/overload                      │ │
│ │  • 504 Gateway Timeout - Upstream service timeout                      │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        ERROR RESPONSE FORMAT                           │ │
│ │                                                                         │ │
│ │  Standard Error Response Structure:                                     │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ {                                                               │   │ │
│ │  │   "success": false,                                             │   │ │
│ │  │   "error": {                                                    │   │ │
│ │  │     "code": "ERROR_CODE",                                       │   │ │
│ │  │     "message": "Human-readable error message",                 │   │ │
│ │  │     "details": {                                                │   │ │
│ │  │       // Additional context-specific information               │   │ │
│ │  │     },                                                          │   │ │
│ │  │     "field_errors": [                                           │   │ │
│ │  │       {                                                         │   │ │
│ │  │         "field": "field_name",                                  │   │ │
│ │  │         "code": "VALIDATION_ERROR",                             │   │ │
│ │  │         "message": "Field-specific error message"              │   │ │
│ │  │       }                                                         │   │ │
│ │  │     ]                                                           │   │ │
│ │  │   },                                                            │   │ │
│ │  │   "meta": {                                                     │   │ │
│ │  │     "request_id": "unique_request_id",                          │   │ │
│ │  │     "timestamp": "2024-09-07T10:30:00Z",                      │   │ │
│ │  │     "api_version": "v1",                                        │   │ │
│ │  │     "documentation_url": "https://docs.allguds.com/errors"     │   │ │
│ │  │   }                                                             │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  Common Error Codes:                                                    │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ Authentication & Authorization:                                 │   │ │
│ │  │ • INVALID_TOKEN - JWT token invalid/expired                    │   │ │
│ │  │ • MISSING_AUTHORIZATION - No auth header provided              │   │ │
│ │  │ • INSUFFICIENT_PERMISSIONS - User lacks required permissions   │   │ │
│ │  │ • MFA_REQUIRED - Multi-factor authentication needed            │   │ │
│ │  │ • TENANT_NOT_FOUND - Invalid tenant specified                  │   │ │
│ │  │                                                                 │   │ │
│ │  │ Validation:                                                     │   │ │
│ │  │ • VALIDATION_FAILED - Request data validation failed           │   │ │
│ │  │ • MISSING_REQUIRED_FIELD - Required field not provided         │   │ │
│ │  │ • INVALID_FORMAT - Field format is incorrect                   │   │ │
│ │  │ • VALUE_TOO_LARGE - Field value exceeds maximum               │   │ │
│ │  │ • VALUE_TOO_SMALL - Field value below minimum                 │   │ │
│ │  │                                                                 │   │ │
│ │  │ Resource Management:                                            │   │ │
│ │  │ • RESOURCE_NOT_FOUND - Requested resource doesn't exist        │   │ │
│ │  │ • RESOURCE_ALREADY_EXISTS - Duplicate resource                 │   │ │
│ │  │ • RESOURCE_IN_USE - Cannot delete, resource is referenced      │   │ │
│ │  │ • RESOURCE_LOCKED - Resource is locked for editing             │   │ │
│ │  │                                                                 │   │ │
│ │  │ System:                                                         │   │ │
│ │  │ • RATE_LIMIT_EXCEEDED - Too many requests                      │   │ │
│ │  │ • MAINTENANCE_MODE - System under maintenance                  │   │ │
│ │  │ • DATABASE_ERROR - Database operation failed                   │   │ │
│ │  │ • EXTERNAL_SERVICE_ERROR - Third-party service error           │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                      VALIDATION ERROR EXAMPLES                         │ │
│ │                                                                         │ │
│ │  Field Validation Error:                                                │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ HTTP/1.1 422 Unprocessable Entity                              │   │ │
│ │  │                                                                 │   │ │
│ │  │ {                                                               │   │ │
│ │  │   "success": false,                                             │   │ │
│ │  │   "error": {                                                    │   │ │
│ │  │     "code": "VALIDATION_FAILED",                                │   │ │
│ │  │     "message": "Request validation failed",                    │   │ │
│ │  │     "field_errors": [                                           │   │ │
│ │  │       {                                                         │   │ │
│ │  │         "field": "email",                                       │   │ │
│ │  │         "code": "INVALID_FORMAT",                               │   │ │
│ │  │         "message": "Please provide a valid email address"      │   │ │
│ │  │       },                                                        │   │ │
│ │  │       {                                                         │   │ │
│ │  │         "field": "password",                                    │   │ │
│ │  │         "code": "VALUE_TOO_SHORT",                              │   │ │
│ │  │         "message": "Password must be at least 8 characters"    │   │ │
│ │  │       },                                                        │   │ │
│ │  │       {                                                         │   │ │
│ │  │         "field": "age",                                         │   │ │
│ │  │         "code": "VALUE_OUT_OF_RANGE",                           │   │ │
│ │  │         "message": "Age must be between 0 and 120"             │   │ │
│ │  │       }                                                         │   │ │
│ │  │     ]                                                           │   │ │
│ │  │   }                                                             │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  Authentication Error:                                                  │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ HTTP/1.1 401 Unauthorized                                       │   │ │
│ │  │                                                                 │   │ │
│ │  │ {                                                               │   │ │
│ │  │   "success": false,                                             │   │ │
│ │  │   "error": {                                                    │   │ │
│ │  │     "code": "INVALID_TOKEN",                                    │   │ │
│ │  │     "message": "Authentication token is invalid or expired",   │   │ │
│ │  │     "details": {                                                │   │ │
│ │  │       "expired_at": "2024-09-07T09:30:00Z",                   │   │ │
│ │  │       "refresh_endpoint": "/auth/refresh"                      │   │ │
│ │  │     }                                                           │   │ │
│ │  │   }                                                             │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  Server Error:                                                          │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ HTTP/1.1 500 Internal Server Error                             │   │ │
│ │  │                                                                 │   │ │
│ │  │ {                                                               │   │ │
│ │  │   "success": false,                                             │   │ │
│ │  │   "error": {                                                    │   │ │
│ │  │     "code": "DATABASE_ERROR",                                   │   │ │
│ │  │     "message": "A database error occurred",                    │   │ │
│ │  │     "details": {                                                │   │ │
│ │  │       "retry_after": 30,                                       │   │ │
│ │  │       "support_contact": "support@allguds.com"                │   │ │
│ │  │     }                                                           │   │ │
│ │  │   },                                                            │   │ │
│ │  │   "meta": {                                                     │   │ │
│ │  │     "request_id": "req_12345",                                  │   │ │
│ │  │     "timestamp": "2024-09-07T10:30:00Z"                       │   │ │
│ │  │   }                                                             │   │ │
│ │  │ }                                                               │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```