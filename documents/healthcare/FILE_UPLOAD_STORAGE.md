# File Upload & Storage Flow Diagrams

## Complete File Management Architecture

### File Upload & Storage Overview
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      FILE UPLOAD & STORAGE SYSTEM                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                          CLIENT LAYER                                   │ │
│ │                                                                         │ │
│ │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │ │
│ │  │ Web Browser     │    │ Mobile App      │    │ Admin Dashboard     │  │ │
│ │  │                 │    │ (React Native)  │    │                     │  │ │
│ │  │• Drag & drop    │    │                 │    │• Bulk uploads       │  │ │
│ │  │• Multiple       │    │• Camera         │    │• File management    │  │ │
│ │  │  selection      │    │• Gallery        │    │• Storage analytics  │  │ │
│ │  │• Progress bars  │    │• Document       │    │• Access controls    │  │ │
│ │  │• Resumable      │    │  picker         │    │                     │  │ │
│ │  │  uploads        │    │• Audio/Video    │    │                     │  │ │
│ │  └─────────────────┘    └─────────────────┘    └─────────────────────┘  │ │
│ │           │                       │                       │              │ │
│ │           └───────────────────────┼───────────────────────┘              │ │
│ │                                   │                                      │ │
│ │  File Types Supported:            ▼                                      │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │ • Images: JPEG, PNG, GIF, WebP, HEIC (max 50MB each)           │   │ │
│ │  │ • Documents: PDF, DOC, DOCX, XLS, XLSX, TXT (max 100MB each)   │   │ │
│ │  │ • Audio: MP3, WAV, AAC, M4A (max 200MB each)                   │   │ │
│ │  │ • Video: MP4, MOV, AVI, WebM (max 1GB each)                    │   │ │
│ │  │ • Archives: ZIP, RAR, TAR, 7Z (max 500MB each)                 │   │ │
│ │  │ • Medical: DICOM, HL7, XML (max 500MB each)                    │   │ │
│ │  │ • Custom: Based on tenant configuration                        │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                         UPLOAD MIDDLEWARE                               │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                    PRE-UPLOAD PROCESSING                        │   │ │
│ │  │                                                                 │   │ │
│ │  │  1. Client-Side Validation:                                    │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ File Size   │  │ File Type   │  │ Permissions │             │   │ │
│ │  │  │ Check       │  │ Validation  │  │ Check       │             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• Max size   │  │• MIME type  │  │• Upload     │             │   │ │
│ │  │  │  per file   │  │  check      │  │  quota      │             │   │ │
│ │  │  │• Total size │  │• File       │  │• User roles │             │   │ │
│ │  │  │  limit      │  │  signature  │  │• Tenant     │             │   │ │
│ │  │  │• Count      │  │• Extension  │  │  limits     │             │   │ │
│ │  │  │  limits     │  │  whitelist  │  │             │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  │                                                                 │   │ │
│ │  │  2. Upload Strategy Selection:                                  │   │ │
│ │  │  ┌─────────────────────────────────────────────────────────┐   │   │ │
│ │  │  │ Small Files (<10MB):     Direct upload                 │   │   │ │
│ │  │  │ Medium Files (10-100MB): Chunked upload                │   │   │ │
│ │  │  │ Large Files (>100MB):    Resumable multipart upload   │   │   │ │
│ │  │  │ Multiple Files:          Parallel batch upload        │   │   │ │
│ │  │  └─────────────────────────────────────────────────────────┘   │   │ │
│ │  │                                                                 │   │ │
│ │  │  3. Progress Tracking & Error Handling:                        │   │ │
│ │  │  ┌─────────────────────────────────────────────────────────┐   │   │ │
│ │  │  │ • Real-time progress updates                            │   │   │ │
│ │  │  │ • Automatic retry on network errors                    │   │   │ │
│ │  │  │ • Pause/resume functionality                           │   │   │ │
│ │  │  │ • Background upload continuation                       │   │   │ │
│ │  │  │ • Offline queue for failed uploads                     │   │   │ │
│ │  │  └─────────────────────────────────────────────────────────┘   │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                          API GATEWAY                                    │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                    UPLOAD ENDPOINTS                             │   │ │
│ │  │                                                                 │   │ │
│ │  │  POST /api/files/upload          # Direct upload              │   │ │
│ │  │  POST /api/files/upload/chunked  # Chunked upload             │   │ │
│ │  │  POST /api/files/upload/multipart# Multipart upload           │   │ │
│ │  │  GET  /api/files/upload/presigned# Pre-signed URL generation   │   │ │
│ │  │  PUT  /api/files/{id}/chunk/{n}  # Chunk upload               │   │ │
│ │  │  POST /api/files/{id}/complete   # Complete multipart         │   │ │
│ │  │                                                                 │   │ │
│ │  │  Request Processing Pipeline:                                   │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ Rate        │  │ Auth &      │  │ Tenant      │             │   │ │
│ │  │  │ Limiting    │  │ Permission  │  │ Quotas      │             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• Per user   │  │• JWT verify │  │• Storage    │             │   │ │
│ │  │  │• Per tenant │  │• Role check │  │  limits     │             │   │ │
│ │  │  │• Per IP     │  │• Resource   │  │• Bandwidth  │             │   │ │
│ │  │  │• File size  │  │  access     │  │• File count │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                       FILE PROCESSING ENGINE                           │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                     SECURITY SCANNING                           │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ Virus       │  │ Malware     │  │ Content     │             │   │ │
│ │  │  │ Scanning    │  │ Detection   │  │ Analysis    │             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• ClamAV     │  │• Custom     │  │• File       │             │   │ │
│ │  │  │• Real-time  │  │  signatures │  │  structure  │             │   │ │
│ │  │  │  scanning   │  │• Heuristic  │  │• Metadata   │             │   │ │
│ │  │  │• Quarantine │  │  analysis   │  │  extraction │             │   │ │
│ │  │  │  on threat  │  │• Behavioral │  │• EXIF data  │             │   │ │
│ │  │  │             │  │  detection  │  │  removal    │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                   CONTENT PROCESSING                            │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ Image       │  │ Document    │  │ Video/Audio │             │   │ │
│ │  │  │ Processing  │  │ Processing  │  │ Processing  │             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• Resize/    │  │• OCR        │  │• Transcoding│             │   │ │
│ │  │  │  compress   │  │  extraction │  │• Thumbnails │             │   │ │
│ │  │  │• Thumbnail  │  │• Text       │  │• Compression│             │   │ │
│ │  │  │  generation │  │  indexing   │  │• Format     │             │   │ │
│ │  │  │• Format     │  │• Watermark  │  │  conversion │             │   │ │
│ │  │  │  conversion │  │  addition   │  │• Metadata   │             │   │ │
│ │  │  │• Quality    │  │• Version    │  │  extraction │             │   │ │
│ │  │  │  optimization│ │  control    │  │             │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                       STORAGE LAYER                                     │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                     PRIMARY STORAGE                             │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ AWS S3      │  │ Azure Blob  │  │ Google      │             │   │ │
│ │  │  │ (Primary)   │  │ (Backup)    │  │ Cloud       │             │   │ │
│ │  │  │             │  │             │  │ (Archive)   │             │   │ │
│ │  │  │• Multi-part │  │• Geo-       │  │• Cold       │             │   │ │
│ │  │  │  upload     │  │  replication│  │  storage    │             │   │ │
│ │  │  │• Server-side│  │• Versioning │  │• Lifecycle  │             │   │ │
│ │  │  │  encryption │  │• Cross-     │  │  policies   │             │   │ │
│ │  │  │• Lifecycle  │  │  region     │  │• Cost       │             │   │ │
│ │  │  │  policies   │  │  sync       │  │  optimization│            │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                   METADATA STORAGE                              │   │ │
│ │  │                                                                 │   │ │
│ │  │  PostgreSQL Database:                                           │   │ │
│ │  │  ┌─────────────────────────────────────────────────────────┐   │   │ │
│ │  │  │ files Table:                                            │   │   │ │
│ │  │  │ • file_id (UUID, PK)                                    │   │   │ │
│ │  │  │ • tenant_id (UUID, FK)                                  │   │   │ │
│ │  │  │ • original_name (VARCHAR)                               │   │   │ │
│ │  │  │ • file_size (BIGINT)                                    │   │   │ │
│ │  │  │ • mime_type (VARCHAR)                                   │   │   │ │
│ │  │  │ • storage_path (TEXT)                                   │   │   │ │
│ │  │  │ • storage_provider (VARCHAR)                            │   │   │ │
│ │  │  │ • checksum (VARCHAR)                                    │   │   │ │
│ │  │  │ • encryption_key_id (VARCHAR)                           │   │   │ │
│ │  │  │ • processed_variants (JSONB)                            │   │   │ │
│ │  │  │ • metadata (JSONB)                                      │   │   │ │
│ │  │  │ • access_permissions (JSONB)                            │   │   │ │
│ │  │  │ • uploaded_by (UUID, FK)                                │   │   │ │
│ │  │  │ • created_at (TIMESTAMP)                                │   │   │ │
│ │  │  │ • updated_at (TIMESTAMP)                                │   │   │ │
│ │  │  │ • deleted_at (TIMESTAMP)                                │   │   │ │
│ │  │  └─────────────────────────────────────────────────────────┘   │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Upload Flow Patterns

### 1. Direct Upload Flow (Small Files)
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DIRECT UPLOAD FLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Client Initiates Upload                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ File Selection:                                                     │   │
│  │ • User selects file(s) via file picker or drag-and-drop            │   │ │
│  │ • Client validates file size, type, and count limits               │   │ │
│  │ • Generate file hash for integrity verification                     │   │ │
│  │ • Create upload progress UI                                         │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Upload Request:                                                     │   │ │
│  │                                                                     │   │ │
│  │ POST /api/files/upload                                              │   │ │
│  │ Content-Type: multipart/form-data                                   │   │ │
│  │ Authorization: Bearer <token>                                       │   │ │
│  │ X-Tenant-ID: <tenant_id>                                            │   │ │
│  │ X-File-Hash: <sha256_hash>                                          │   │ │
│  │                                                                     │   │ │
│  │ Form Data:                                                          │   │ │
│  │ ┌─────────────────────────────────────────────────────────────┐   │   │ │
│  │ │ file: <binary_data>                                         │   │   │ │
│  │ │ metadata: {                                                 │   │   │ │
│  │ │   "original_name": "document.pdf",                         │   │   │ │
│  │ │   "description": "Contract document",                      │   │   │ │
│  │ │   "tags": ["contract", "legal"],                           │   │   │ │
│  │ │   "associated_record_id": "record_uuid",                   │   │   │ │
│  │ │   "access_level": "private"                                │   │   │ │
│  │ │ }                                                           │   │   │ │
│  │ └─────────────────────────────────────────────────────────────┘   │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Server Processing:                                                  │   │ │
│  │                                                                     │   │ │
│  │ 1. Authentication & Authorization                                   │   │ │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │ │
│  │    │ • Verify JWT token and extract user context              │ │   │ │
│  │    │ • Check tenant membership and upload permissions         │ │   │ │
│  │    │ • Validate file size against tenant quota               │ │   │ │
│  │    │ • Check rate limiting (uploads per minute/hour)          │ │   │ │
│  │    └─────────────────────────────────────────────────────────────┘ │   │ │
│  │                                                                     │   │ │
│  │ 2. File Validation                                                  │   │ │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │ │
│  │    │ • Verify file hash matches client-provided hash          │ │   │ │
│  │    │ • Check MIME type against whitelist                      │ │   │ │
│  │    │ • Scan file signature (magic numbers)                    │ │   │ │
│  │    │ • Validate file is not corrupted                         │ │   │ │
│  │    └─────────────────────────────────────────────────────────────┘ │   │ │
│  │                                                                     │   │ │
│  │ 3. Security Scanning                                                │   │ │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │ │
│  │    │ • Run virus scan (ClamAV)                                 │ │   │ │
│  │    │ • Check for malware signatures                            │ │   │ │
│  │    │ • Analyze file structure for threats                     │ │   │ │
│  │    │ • Quarantine if security issues found                    │ │   │ │
│  │    └─────────────────────────────────────────────────────────────┘ │   │ │
│  │                                                                     │   │ │
│  │ 4. Storage & Processing                                             │   │ │
│  │    ┌─────────────────────────────────────────────────────────────┐ │   │ │
│  │    │ • Generate unique file ID and storage path                │ │   │ │
│  │    │ • Encrypt file content with tenant-specific key          │ │   │ │
│  │    │ • Upload to primary storage (S3)                         │ │   │ │
│  │    │ • Create database record with metadata                   │ │   │ │
│  │    │ • Queue background processing jobs                       │ │   │ │
│  │    └─────────────────────────────────────────────────────────────┘ │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Response to Client:                                                 │   │ │
│  │                                                                     │   │ │
│  │ HTTP/1.1 201 Created                                                │   │ │
│  │ Content-Type: application/json                                      │   │ │
│  │                                                                     │   │ │
│  │ {                                                                   │   │ │
│  │   "success": true,                                                  │   │ │
│  │   "data": {                                                         │   │ │
│  │     "file_id": "file_uuid",                                         │   │ │
│  │     "original_name": "document.pdf",                                │   │ │
│  │     "file_size": 2048576,                                           │   │ │
│  │     "mime_type": "application/pdf",                                 │   │ │
│  │     "checksum": "sha256_hash",                                       │   │ │
│  │     "download_url": "/api/files/file_uuid/download",                 │   │ │
│  │     "thumbnail_url": "/api/files/file_uuid/thumbnail",               │   │ │
│  │     "processing_status": "queued",                                   │   │ │
│  │     "upload_time": "2024-09-07T10:30:00Z",                         │   │ │
│  │     "metadata": {                                                    │   │ │
│  │       "description": "Contract document",                           │   │ │
│  │       "tags": ["contract", "legal"]                                 │   │ │
│  │     }                                                                │   │ │
│  │   },                                                                 │   │ │
│  │   "meta": {                                                          │   │ │
│  │     "request_id": "req_uuid",                                        │   │ │
│  │     "processing_jobs": ["thumbnail", "ocr", "backup"]               │   │ │
│  │   }                                                                  │   │ │
│  │ }                                                                    │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Background Processing (Async):                                      │   │ │
│  │                                                                     │   │ │
│  │ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                   │   │ │
│  │ │ Thumbnail   │  │ OCR/Text    │  │ Backup      │                   │   │ │
│  │ │ Generation  │  │ Extraction  │  │ Replication │                   │   │ │
│  │ │             │  │             │  │             │                   │   │ │
│  │ │• Multiple   │  │• Full-text  │  │• Cross-     │                   │   │ │
│  │ │  sizes      │  │  indexing   │  │  region     │                   │   │ │
│  │ │• WebP       │  │• Language   │  │• Multiple   │                   │   │ │
│  │ │  format     │  │  detection  │  │  providers  │                   │   │ │
│  │ │• Quality    │  │• Metadata   │  │• Checksums  │                   │   │ │
│  │ │  optimization│ │  extraction │  │• Verify     │                   │   │ │
│  │ └─────────────┘  └─────────────┘  └─────────────┘                   │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2. Chunked Upload Flow (Large Files)
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CHUNKED UPLOAD FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 1: Upload Initialization                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Client Preparation:                                                 │   │ │
│  │ • Calculate total file size and chunk count                         │   │ │
│  │ • Generate unique upload session ID                                 │   │ │
│  │ • Create file hash for integrity verification                       │   │ │
│  │ • Split file into chunks (typically 5MB - 100MB each)               │   │ │
│  │                                                                     │   │ │
│  │ Initialize Upload Request:                                          │   │ │
│  │ ┌─────────────────────────────────────────────────────────────┐   │   │ │
│  │ │ POST /api/files/upload/init                                 │   │   │ │
│  │ │ {                                                           │   │   │ │
│  │ │   "filename": "large_video.mp4",                           │   │   │ │
│  │ │   "total_size": 1073741824,                                │   │   │ │
│  │ │   "chunk_size": 10485760,                                  │   │   │ │
│  │ │   "total_chunks": 102,                                     │   │   │ │
│  │ │   "file_hash": "sha256_hash",                              │   │   │ │
│  │ │   "mime_type": "video/mp4",                                │   │   │ │
│  │ │   "metadata": {...}                                        │   │   │ │
│  │ │ }                                                           │   │   │ │
│  │ └─────────────────────────────────────────────────────────────┘   │   │ │
│  │                                                                     │   │ │
│  │ Server Response:                                                    │   │ │
│  │ ┌─────────────────────────────────────────────────────────────┐   │   │ │
│  │ │ {                                                           │   │   │ │
│  │ │   "upload_id": "upload_session_uuid",                      │   │   │ │
│  │ │   "file_id": "file_uuid",                                  │   │   │ │
│  │   "chunk_urls": [                                           │   │   │ │
│  │ │     "/api/files/upload_uuid/chunk/1",                     │   │   │ │
│  │ │     "/api/files/upload_uuid/chunk/2",                     │   │   │ │
│  │ │     "...",                                                │   │   │ │
│  │ │     "/api/files/upload_uuid/chunk/102"                    │   │   │ │
│  │ │   ],                                                       │   │   │ │
│  │ │   "expires_at": "2024-09-07T12:30:00Z"                    │   │   │ │
│  │ │ }                                                           │   │   │ │
│  │ └─────────────────────────────────────────────────────────────┘   │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Phase 2: Parallel Chunk Upload                                     │   │ │
│  │                                                                     │   │ │
│  │  Chunk Upload Strategy:                                             │   │ │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │ │
│  │  │                    PARALLEL WORKERS                         │   │   │ │
│  │  │                                                             │   │   │ │
│  │  │  Worker 1:      Worker 2:      Worker 3:      Worker 4:    │   │   │ │
│  │  │  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │   │   │ │
│  │  │  │ Chunk 1 │    │ Chunk 2 │    │ Chunk 3 │    │ Chunk 4 │  │   │   │ │
│  │  │  │ ▼▼▼▼▼▼▼ │    │ ▼▼▼▼▼▼▼ │    │ ▼▼▼▼▼▼▼ │    │ ▼▼▼▼▼▼▼ │  │   │   │ │
│  │  │  │ Upload  │    │ Upload  │    │ Upload  │    │ Upload  │  │   │   │ │
│  │  │  │ 98% ✓   │    │ 45%     │    │ 72%     │    │ 12%     │  │   │   │ │
│  │  │  └─────────┘    └─────────┘    └─────────┘    └─────────┘  │   │   │ │
│  │  │      │              │              │              │        │   │   │ │
│  │  │      └──────────────┼──────────────┼──────────────┘        │   │   │ │
│  │  │                     │              │                       │   │   │ │
│  │  │  Combined Progress: 56.75% (58/102 chunks completed)       │   │   │ │
│  │  │                                                             │   │   │ │
│  │  │  Chunk Upload Request:                                      │   │   │ │
│  │  │  ┌─────────────────────────────────────────────────────┐   │   │   │ │
│  │  │  │ PUT /api/files/upload_uuid/chunk/1                  │   │   │   │ │
│  │  │  │ Content-Type: application/octet-stream              │   │   │   │ │
│  │  │  │ Content-Length: 10485760                           │   │   │   │ │
│  │  │  │ X-Chunk-Hash: sha256_chunk_hash                     │   │   │   │ │
│  │  │  │ X-Chunk-Index: 1                                    │   │   │   │ │
│  │  │  │                                                     │   │   │   │ │
│  │  │  │ <binary_chunk_data>                                 │   │   │   │ │
│  │  │  └─────────────────────────────────────────────────────┘   │   │   │ │
│  │  │                                                             │   │   │ │
│  │  │  Error Handling & Retry Logic:                             │   │   │ │
│  │  │  • Network timeout → Exponential backoff retry             │   │   │ │
│  │  │  • Chunk corruption → Re-upload specific chunk             │   │   │ │
│  │  │  • Rate limit → Pause and resume with delay               │   │   │ │
│  │  │  • Server error → Retry up to 3 times                     │   │   │ │
│  │  └─────────────────────────────────────────────────────────────┘   │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Phase 3: Upload Completion & Assembly                              │   │ │
│  │                                                                     │   │ │
│  │ Complete Upload Request:                                            │   │ │
│  │ ┌─────────────────────────────────────────────────────────────┐   │   │ │
│  │ │ POST /api/files/upload_uuid/complete                        │   │   │ │
│  │ │ {                                                           │   │   │ │
│  │ │   "chunk_hashes": [                                        │   │   │ │
│  │ │     "chunk_1_hash",                                        │   │   │ │
│  │ │     "chunk_2_hash",                                        │   │   │ │
│  │ │     "...",                                                 │   │   │ │
│  │ │     "chunk_102_hash"                                       │   │   │ │
│  │ │   ]                                                        │   │   │ │
│  │ │ }                                                           │   │   │ │
│  │ └─────────────────────────────────────────────────────────────┘   │   │ │
│  │                                                                     │   │ │
│  │ Server Processing:                                                  │   │ │
│  │ ┌─────────────────────────────────────────────────────────────┐   │   │ │
│  │ │ 1. Verify all chunks received and integrity               │   │   │ │
│  │ │ 2. Assemble chunks into complete file                      │   │   │ │
│  │ │ 3. Verify final file hash matches original                 │   │   │ │
│  │ │ 4. Run security scanning on complete file                  │   │   │ │
│  │ │ 5. Move to permanent storage location                      │   │   │ │
│  │ │ 6. Update database with final file metadata               │   │   │ │
│  │ │ 7. Clean up temporary chunks                               │   │   │ │
│  │ │ 8. Queue background processing jobs                        │   │   │ │
│  │ └─────────────────────────────────────────────────────────────┘   │   │ │
│  │                                                                     │   │ │
│  │ Success Response:                                                   │   │ │
│  │ ┌─────────────────────────────────────────────────────────────┐   │   │ │
│  │ │ {                                                           │   │   │ │
│  │ │   "success": true,                                          │   │   │ │
│  │ │   "file_id": "file_uuid",                                   │   │   │ │
│  │ │   "status": "completed",                                    │   │   │ │
│  │ │   "final_size": 1073741824,                                │   │   │ │
│  │ │   "upload_time": "2024-09-07T11:45:30Z",                  │   │   │ │
│  │ │   "processing_jobs": ["transcode", "thumbnail", "backup"]  │   │   │ │
│  │ │ }                                                           │   │   │ │
│  │ └─────────────────────────────────────────────────────────────┘   │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File Download & Access Control

### 1. Secure Download Flow
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SECURE DOWNLOAD SYSTEM                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Access Control Matrix:                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                     PERMISSION LEVELS                       │   │   │
│  │  │                                                             │   │   │
│  │  │  Public:       • No authentication required                │   │   │
│  │  │               • Direct CDN links                           │   │   │
│  │  │               • Marketing materials, logos                │   │   │
│  │  │                                                             │   │   │
│  │  │  Private:      • Authentication required                   │   │   │
│  │  │               • User must be in same tenant                │   │   │
│  │  │               • Time-limited signed URLs                   │   │   │
│  │  │                                                             │   │   │
│  │  │  Restricted:   • Specific role/permission required         │   │   │
│  │  │               • Owner or assigned users only              │   │   │
│  │  │               • Audit logged access                       │   │   │
│  │  │                                                             │   │   │
│  │  │  Confidential: • Multi-factor authentication required      │   │   │
│  │  │               • IP whitelist restrictions                  │   │   │
│  │  │               • Download watermarking                     │   │   │
│  │  │               • Prevent screenshots (DRM)                 │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Download Request Flow:                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  1. Client Download Request                                         │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ GET /api/files/{file_id}/download                           │   │   │ │
│  │  │ Authorization: Bearer <jwt_token>                           │   │   │ │
│  │  │ X-Tenant-ID: <tenant_id>                                    │   │   │ │
│  │  │ Accept-Encoding: gzip, deflate                              │   │   │ │
│  │  │ Range: bytes=0-1024 (for partial/streaming downloads)      │   │   │ │
│  │  └─────────────────────────────────────────────────────────────┘   │   │ │
│  │                                                                     │   │
│  │  2. Authorization & Permission Check                                │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ • Verify JWT token and extract user context              │   │   │ │
│  │  │ • Check tenant membership                                  │   │   │ │
│  │  │ • Validate file exists and not deleted                    │   │   │ │
│  │  │ • Check file access permissions                           │   │   │ │
│  │  │ • Verify user role/permissions for file access            │   │   │ │
│  │  │ • Apply IP restrictions if configured                     │   │   │ │
│  │  │ • Check download quota limits                             │   │   │ │
│  │  │ • Log access attempt for audit                            │   │   │ │
│  │  └─────────────────────────────────────────────────────────────┘   │   │ │
│  │                                                                     │   │
│  │  3. Generate Signed Download URL                                    │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ • Create time-limited (15 minutes) signed URL               │   │   │ │
│  │  │ • Include security headers and restrictions                 │   │   │ │
│  │  │ • Add download tracking parameters                         │   │   │ │
│  │  │ • Apply content-disposition headers                        │   │   │ │
│  │  │                                                             │   │   │ │
│  │  │ Response Options:                                           │   │   │ │
│  │  │ A) Direct Download (small files):                          │   │   │ │
│  │  │    • Stream file content directly from storage             │   │   │ │
│  │  │    • Apply range request support                           │   │   │ │
│  │  │                                                             │   │   │ │
│  │  │ B) Redirect to Signed URL (large files):                   │   │   │ │
│  │  │    • Return 302 redirect to pre-signed S3 URL             │   │   │ │
│  │  │    • Include cache headers and security policies          │   │   │ │
│  │  └─────────────────────────────────────────────────────────────┘   │   │ │
│  │                                                                     │   │
│  │  4. Download Response Examples                                      │   │
│  │                                                                     │   │
│  │  Direct Download Response:                                          │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ HTTP/1.1 200 OK                                             │   │   │ │
│  │  │ Content-Type: application/pdf                               │   │   │ │
│  │  │ Content-Length: 2048576                                     │   │   │ │
│  │  │ Content-Disposition: attachment; filename="document.pdf"    │   │   │ │
│  │  │ X-Content-Type-Options: nosniff                             │   │   │ │
│  │  │ X-Frame-Options: DENY                                       │   │   │ │
│  │  │ Cache-Control: private, no-cache                            │   │   │ │
│  │  │ X-Download-ID: download_tracking_uuid                       │   │   │ │
│  │  │                                                             │   │   │ │
│  │  │ <binary_file_content>                                       │   │   │ │
│  │  └─────────────────────────────────────────────────────────────┘   │   │ │
│  │                                                                     │   │
│  │  Redirect Response:                                                 │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ HTTP/1.1 302 Found                                          │   │   │ │
│  │  │ Location: https://s3.amazonaws.com/bucket/path/file?        │   │   │ │
│  │  │           X-Amz-Algorithm=AWS4-HMAC-SHA256&                │   │   │ │
│  │  │           X-Amz-Expires=900&                                │   │   │ │
│  │  │           X-Amz-SignedHeaders=host&                         │   │   │ │
│  │  │           X-Amz-Signature=signature                         │   │   │ │
│  │  │ X-Download-ID: download_tracking_uuid                       │   │   │ │
│  │  │ Cache-Control: no-cache                                     │   │   │ │
│  │  └─────────────────────────────────────────────────────────────┘   │   │ │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Storage Optimization & Lifecycle Management

### 1. Intelligent Storage Tiering
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       STORAGE LIFECYCLE MANAGEMENT                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Storage Tiers & Transition Rules:                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                      HOT TIER                               │   │   │
│  │  │  AWS S3 Standard / Azure Hot                                │   │   │
│  │  │                                                             │   │   │
│  │  │  Characteristics:                                           │   │   │
│  │  │  • Files uploaded in last 30 days                          │   │   │
│  │  │  • Frequently accessed files (>1 access/week)              │   │   │
│  │  │  • Active user documents and media                         │   │   │
│  │  │  • Instant retrieval (milliseconds)                        │   │   │
│  │  │  • Highest cost per GB                                     │   │   │
│  │  │                                                             │   │   │
│  │  │  Access Pattern: Real-time                                 │   │   │
│  │  │  Cost: $0.023/GB/month                                     │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  │                              │                                      │   │
│  │                              ▼ (After 30 days OR low access)        │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                      WARM TIER                              │   │   │
│  │  │  AWS S3 Intelligent-Tiering / Azure Cool                   │   │   │
│  │  │                                                             │   │   │
│  │  │  Characteristics:                                           │   │   │
│  │  │  • Files 30-90 days old with occasional access             │   │   │
│  │  │  • Backup files and document archives                      │   │   │
│  │  │  • Reference materials and completed projects              │   │   │
│  │  │  • Retrieval in seconds                                    │   │   │
│  │  │  • 40% lower cost than hot storage                         │   │   │
│  │  │                                                             │   │   │
│  │  │  Access Pattern: Weekly/Monthly                            │   │   │
│  │  │  Cost: $0.014/GB/month + $0.01/GB retrieval              │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  │                              │                                      │   │
│  │                              ▼ (After 90 days OR very low access)   │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                      COLD TIER                              │   │   │
│  │  │  AWS S3 Glacier Flexible / Azure Archive                   │   │   │
│  │  │                                                             │   │   │
│  │  │  Characteristics:                                           │   │   │
│  │  │  • Files >90 days old with rare access                     │   │   │
│  │  │  • Compliance and regulatory archives                      │   │   │
│  │  │  • Historical data and audit trails                        │   │   │
│  │  │  • Retrieval in 1-5 minutes                                │   │   │
│  │  │  • 70% lower cost than hot storage                         │   │   │
│  │  │                                                             │   │   │
│  │  │  Access Pattern: Rarely (compliance/audit)                 │   │   │
│  │  │  Cost: $0.007/GB/month + $0.03/GB retrieval              │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  │                              │                                      │   │
│  │                              ▼ (After 365 days OR archive policy)   │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                    FROZEN TIER                              │   │   │
│  │  │  AWS S3 Glacier Deep Archive / Azure Archive Deep          │   │   │
│  │  │                                                             │   │   │
│  │  │  Characteristics:                                           │   │   │
│  │  │  • Files >1 year old, long-term retention                  │   │   │
│  │  │  • Legal holds and compliance requirements                 │   │   │
│  │  │  • Disaster recovery and business continuity               │   │   │
│  │  │  • Retrieval in 12+ hours                                  │   │   │
│  │  │  • 80% lower cost than hot storage                         │   │   │
│  │  │                                                             │   │   │
│  │  │  Access Pattern: Emergency/Legal only                      │   │   │
│  │  │  Cost: $0.004/GB/month + $0.10/GB retrieval              │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Automated Transition Logic:                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  File Transition Algorithm:                                         │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ function determineStorageTier(file) {                       │   │   │
│  │  │   const now = new Date();                                   │   │   │
│  │  │   const ageInDays = (now - file.created_at) / 86400000;     │   │   │
│  │  │   const lastAccessed = (now - file.last_accessed) / 86400000; │   │ │
│  │  │   const accessCount = file.access_count_30_days;            │   │   │
│  │  │                                                              │   │   │
│  │  │   // Business logic for tier determination                  │   │   │
│  │  │   if (accessCount > 10 || ageInDays < 7) {                  │   │   │
│  │  │     return 'HOT';                                           │   │   │
│  │  │   }                                                          │   │   │
│  │  │                                                              │   │   │
│  │  │   if (ageInDays < 30 && accessCount > 1) {                  │   │   │
│  │  │     return 'HOT';                                           │   │   │
│  │  │   }                                                          │   │   │
│  │  │                                                              │   │   │
│  │  │   if (ageInDays < 90 && lastAccessed < 30) {                │   │   │
│  │  │     return 'WARM';                                          │   │   │
│  │  │   }                                                          │   │   │
│  │  │                                                              │   │   │
│  │  │   if (ageInDays < 365) {                                    │   │   │
│  │  │     return 'COLD';                                          │   │   │
│  │  │   }                                                          │   │   │
│  │  │                                                              │   │   │
│  │  │   return 'FROZEN';                                          │   │   │
│  │  │ }                                                            │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │  Special Rules:                                                     │   │
│  │  • HIPAA files: Minimum 7 years in cold storage                    │   │
│  │  • Legal hold: Prevent any transitions until released              │   │
│  │  • User favorites: Keep in warm tier regardless of age             │   │
│  │  • System files: Always in hot tier                                │   │
│  │  • Tenant preferences: Override default policies                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```