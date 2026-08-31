# Multi-Tenant Database Schema Design

## Database Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        POSTGRESQL DATABASE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐              │
│  │   TENANTS     │    │   TENANT      │    │   TENANT      │              │
│  │   METADATA    │    │   CONFIG      │    │   USERS       │              │
│  │               │    │               │    │               │              │
│  │ • tenant_id   │───▶│ • tenant_id   │───▶│ • tenant_id   │              │
│  │ • name        │    │ • branding    │    │ • user_id     │              │
│  │ • domain      │    │ • features    │    │ • email       │              │
│  │ • status      │    │ • ui_config   │    │ • roles       │              │
│  │ • created_at  │    │ • industry    │    │ • permissions │              │
│  └───────────────┘    └───────────────┘    └───────────────┘              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      BUSINESS DATA                                  │   │
│  │  (All tables include tenant_id for Row-Level Security)             │   │
│  │                                                                     │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │   │
│  │  │   RECORDS   │  │   FORMS     │  │ WORKFLOWS   │  │   FILES   │ │   │
│  │  │             │  │             │  │             │  │           │ │   │
│  │  │• tenant_id  │  │• tenant_id  │  │• tenant_id  │  │• tenant_id│ │   │
│  │  │• record_id  │  │• form_id    │  │• workflow_id│  │• file_id  │ │   │
│  │  │• data       │  │• schema     │  │• state      │  │• url      │ │   │
│  │  │• status     │  │• validation │  │• rules      │  │• metadata │ │   │
│  │  │• created_by │  │• version    │  │• created_by │  │• size     │ │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        AUDIT LOGS                                  │   │
│  │                    (HIPAA Compliance)                              │   │
│  │                                                                     │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │   │
│  │  │ USER_AUDIT  │  │ DATA_AUDIT  │  │ SYSTEM_AUDIT│                │   │
│  │  │             │  │             │  │             │                │   │
│  │  │• tenant_id  │  │• tenant_id  │  │• tenant_id  │                │   │
│  │  │• user_id    │  │• table_name │  │• event_type │                │   │
│  │  │• action     │  │• record_id  │  │• details    │                │   │
│  │  │• ip_address │  │• old_values │  │• timestamp  │                │   │
│  │  │• timestamp  │  │• new_values │  │• severity   │                │   │
│  │  │• user_agent │  │• timestamp  │  │             │                │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Schema Tables

### 1. Tenant Management Tables

```sql
-- Core tenant information
CREATE TABLE tenants (
    tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(100) UNIQUE NOT NULL,
    domain VARCHAR(255),
    status tenant_status DEFAULT 'active',
    plan_type VARCHAR(50) DEFAULT 'basic',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenant configuration and customization
CREATE TABLE tenant_configurations (
    config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    
    -- Branding
    primary_color VARCHAR(7) DEFAULT '#007AFF',
    secondary_color VARCHAR(7) DEFAULT '#5856D6',
    accent_color VARCHAR(7) DEFAULT '#FF9500',
    logo_url TEXT,
    app_name VARCHAR(255),
    company_name VARCHAR(255),
    
    -- Feature flags (JSONB for flexibility)
    features JSONB DEFAULT '{}',
    
    -- UI configuration
    ui_config JSONB DEFAULT '{}',
    
    -- Industry-specific settings
    industry_type VARCHAR(100),
    industry_config JSONB DEFAULT '{}',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenant users and roles
CREATE TABLE tenant_users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    roles JSONB DEFAULT '["user"]',
    permissions JSONB DEFAULT '{}',
    last_login TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(tenant_id, email)
);
```

### 2. Business Data Tables (With RLS)

```sql
-- Generic records table for flexible data storage
CREATE TABLE records (
    record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
    
    -- Record metadata
    record_type VARCHAR(100) NOT NULL, -- 'patient', 'product', 'appointment', etc.
    title VARCHAR(500),
    description TEXT,
    
    -- Flexible JSON data storage
    data JSONB NOT NULL DEFAULT '{}',
    
    -- Status and workflow
    status VARCHAR(100) DEFAULT 'active',
    workflow_state VARCHAR(100),
    
    -- Audit fields
    created_by UUID REFERENCES tenant_users(user_id),
    updated_by UUID REFERENCES tenant_users(user_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    -- Search optimization
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED
);

-- Dynamic forms configuration
CREATE TABLE forms (
    form_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
    
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- JSON schema for form fields
    schema JSONB NOT NULL,
    
    -- Validation rules
    validation_rules JSONB DEFAULT '{}',
    
    -- Version control
    version INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_by UUID REFERENCES tenant_users(user_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- File attachments
CREATE TABLE files (
    file_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
    
    -- File metadata
    original_name VARCHAR(500) NOT NULL,
    file_type VARCHAR(100),
    file_size BIGINT,
    mime_type VARCHAR(100),
    
    -- Storage information
    storage_path TEXT NOT NULL,
    storage_provider VARCHAR(50) DEFAULT 's3',
    
    -- Security
    is_encrypted BOOLEAN DEFAULT TRUE,
    encryption_key_id VARCHAR(255),
    
    -- Associations
    associated_record_id UUID,
    associated_record_type VARCHAR(100),
    
    uploaded_by UUID REFERENCES tenant_users(user_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow states and transitions
CREATE TABLE workflows (
    workflow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
    
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- State machine definition
    states JSONB NOT NULL, -- Array of possible states
    transitions JSONB NOT NULL, -- Valid state transitions
    
    -- Rules and conditions
    rules JSONB DEFAULT '{}',
    
    record_type VARCHAR(100), -- Which record types this applies to
    
    created_by UUID REFERENCES tenant_users(user_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 3. Audit and Compliance Tables

```sql
-- User activity audit log
CREATE TABLE user_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
    
    -- User information
    user_id UUID REFERENCES tenant_users(user_id),
    user_email VARCHAR(255),
    
    -- Action details
    action VARCHAR(100) NOT NULL, -- 'login', 'logout', 'view', 'create', 'update', 'delete'
    resource_type VARCHAR(100), -- 'record', 'file', 'user', etc.
    resource_id UUID,
    
    -- Request context
    ip_address INET,
    user_agent TEXT,
    session_id VARCHAR(255),
    
    -- Additional details
    details JSONB DEFAULT '{}',
    
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Data change audit log
CREATE TABLE data_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
    
    -- Changed record information
    table_name VARCHAR(100) NOT NULL,
    record_id UUID NOT NULL,
    
    -- Change details
    operation VARCHAR(10) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
    old_values JSONB,
    new_values JSONB,
    changed_fields TEXT[], -- Array of changed field names
    
    -- User context
    changed_by UUID REFERENCES tenant_users(user_id),
    
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- System events audit log
CREATE TABLE system_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(tenant_id), -- NULL for system-wide events
    
    event_type VARCHAR(100) NOT NULL, -- 'backup', 'sync', 'migration', 'error'
    event_category VARCHAR(50) NOT NULL, -- 'security', 'performance', 'data', 'system'
    severity VARCHAR(20) DEFAULT 'info', -- 'debug', 'info', 'warning', 'error', 'critical'
    
    message TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    
    -- Context
    source VARCHAR(100), -- 'api', 'background-job', 'migration', etc.
    correlation_id UUID, -- For tracking related events
    
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Row-Level Security (RLS) Implementation

```sql
-- Enable RLS on all tenant-specific tables
ALTER TABLE tenant_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_audit_log ENABLE ROW LEVEL SECURITY;

-- RLS policies for tenant isolation
CREATE POLICY tenant_isolation ON tenant_configurations
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON tenant_users
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON records
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON forms
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON files
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON workflows
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON user_audit_log
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON data_audit_log
FOR ALL TO app_user
USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

## Indexing Strategy

```sql
-- Primary indexes for tenant isolation
CREATE INDEX idx_tenant_configurations_tenant_id ON tenant_configurations(tenant_id);
CREATE INDEX idx_tenant_users_tenant_id ON tenant_users(tenant_id);
CREATE INDEX idx_tenant_users_email ON tenant_users(tenant_id, email);
CREATE INDEX idx_records_tenant_id ON records(tenant_id);
CREATE INDEX idx_records_type_status ON records(tenant_id, record_type, status);
CREATE INDEX idx_records_search ON records USING GIN(search_vector);
CREATE INDEX idx_forms_tenant_id ON forms(tenant_id);
CREATE INDEX idx_files_tenant_id ON files(tenant_id);
CREATE INDEX idx_workflows_tenant_id ON workflows(tenant_id);

-- Audit log indexes for performance
CREATE INDEX idx_user_audit_tenant_time ON user_audit_log(tenant_id, timestamp DESC);
CREATE INDEX idx_data_audit_tenant_table_time ON data_audit_log(tenant_id, table_name, timestamp DESC);
CREATE INDEX idx_system_audit_time ON system_audit_log(timestamp DESC);
CREATE INDEX idx_system_audit_severity ON system_audit_log(severity, timestamp DESC);

-- Performance indexes
CREATE INDEX idx_records_created_at ON records(tenant_id, created_at DESC);
CREATE INDEX idx_records_updated_at ON records(tenant_id, updated_at DESC);
CREATE INDEX idx_files_created_at ON files(tenant_id, created_at DESC);
```

## Database Triggers for Audit Logging

```sql
-- Function to create audit log entries
CREATE OR REPLACE FUNCTION create_audit_log() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO data_audit_log (
            tenant_id, table_name, record_id, operation, 
            old_values, changed_by, timestamp
        ) VALUES (
            OLD.tenant_id, TG_TABLE_NAME, OLD.record_id, 'DELETE',
            row_to_json(OLD), current_setting('app.current_user_id')::UUID, NOW()
        );
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO data_audit_log (
            tenant_id, table_name, record_id, operation,
            old_values, new_values, changed_by, timestamp
        ) VALUES (
            NEW.tenant_id, TG_TABLE_NAME, NEW.record_id, 'UPDATE',
            row_to_json(OLD), row_to_json(NEW), 
            current_setting('app.current_user_id')::UUID, NOW()
        );
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO data_audit_log (
            tenant_id, table_name, record_id, operation,
            new_values, changed_by, timestamp
        ) VALUES (
            NEW.tenant_id, TG_TABLE_NAME, NEW.record_id, 'INSERT',
            row_to_json(NEW), current_setting('app.current_user_id')::UUID, NOW()
        );
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for audit logging
CREATE TRIGGER records_audit_trigger
    AFTER INSERT OR UPDATE OR DELETE ON records
    FOR EACH ROW EXECUTE FUNCTION create_audit_log();

CREATE TRIGGER files_audit_trigger
    AFTER INSERT OR UPDATE OR DELETE ON files
    FOR EACH ROW EXECUTE FUNCTION create_audit_log();

CREATE TRIGGER tenant_users_audit_trigger
    AFTER INSERT OR UPDATE OR DELETE ON tenant_users
    FOR EACH ROW EXECUTE FUNCTION create_audit_log();
```

## Data Relationships Diagram

```
TENANTS ────────┬─────────── TENANT_CONFIGURATIONS
    │           │
    │           ├─────────── TENANT_USERS
    │           │                │
    │           │                ├── USER_AUDIT_LOG
    │           │                │
    │           ├─────────── RECORDS ──────┬── FILES
    │           │                │         │
    │           │                └── DATA_AUDIT_LOG
    │           │
    │           ├─────────── FORMS
    │           │
    │           ├─────────── WORKFLOWS
    │           │
    │           └─────────── SYSTEM_AUDIT_LOG
```

## Mobile Offline Database Schema (SQLite)

```sql
-- Local SQLite schema for offline operations
-- Mirrors server structure but optimized for mobile

CREATE TABLE local_config (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE sync_metadata (
    table_name TEXT PRIMARY KEY,
    last_sync_timestamp TEXT,
    pending_changes_count INTEGER DEFAULT 0
);

CREATE TABLE pending_changes (
    change_id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE'
    data TEXT, -- JSON data
    timestamp TEXT NOT NULL,
    sync_status TEXT DEFAULT 'pending' -- 'pending', 'syncing', 'synced', 'error'
);

-- Local copies of server tables (simplified)
CREATE TABLE local_records (
    record_id TEXT PRIMARY KEY,
    record_type TEXT NOT NULL,
    title TEXT,
    data TEXT, -- JSON
    status TEXT,
    created_at TEXT,
    updated_at TEXT,
    server_updated_at TEXT, -- For conflict resolution
    is_deleted INTEGER DEFAULT 0
);

CREATE TABLE local_files (
    file_id TEXT PRIMARY KEY,
    original_name TEXT,
    local_path TEXT,
    sync_status TEXT DEFAULT 'local', -- 'local', 'uploading', 'synced'
    server_url TEXT,
    created_at TEXT
);
```