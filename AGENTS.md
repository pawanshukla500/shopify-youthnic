# Shopify Youthnic OMS — Agent Engineering Guide & Knowledge Base

> **TaskFlow Pro Project**: `Shopify Youthnic OMS`  
> **TaskFlow Project ID**: `a7f820cb-4885-486d-92d2-c8e4a63054f4`  
> **Repository**: `pawanshukla500/shopify-youthnic` (Branch: `main`)  
> **Last Verified**: 2026-09-27  

---

## 1. Operating Rules for AI Agents

1. **TaskFlow Pro Synchronization**:
   - At the beginning of any coding or architectural work, call `sync_coding_work` with project name `"Shopify Youthnic OMS"` and a descriptive task title.
   - Keep calling `sync_coding_work` with `task_id` and `progress_note` as milestones are reached (`in_progress` → `in_review` → `done`).
   - Active tracking URL: `https://task.youthnic.shop/my-tasks?task=164ba233-9b5f-4c14-bc34-066cef4300fc`

2. **Command Execution in Windows PowerShell**:
   - Running `.ps1` scripts directly may be restricted by system execution policy. Always invoke node commands via `cmd.exe /c "npm test"`, `cmd.exe /c "npm run build"`, etc.
   - Avoid PowerShell pipeline redirection typos like `> $null` which creates a literal file named `$null`.

3. **Verification Before Committing**:
   - All unit and integration tests must pass: `cmd.exe /c "npm test"` (Vitest suite, 38 passing tests).
   - Backend TypeScript build must compile cleanly: `cmd.exe /c "npm run build"`.
   - Frontend Vite bundle must build cleanly: `cmd.exe /c "cd frontend && npm run build"`.

---

## 2. System Architecture & Tech Stack

```
                              ┌──────────────────────────────────────────────┐
                              │           Shopify Store (Youthnic)           │
                              │         youthnic2024.myshopify.com           │
                              └──────────────────────┬───────────────────────┘
                                                     │ Webhooks & Admin API (2026-09-25+ cutoff)
                                                     ▼
┌────────────────────────┐    ┌──────────────────────────────────────────────┐    ┌────────────────────────┐
│     Admin Frontend     │◄──►│             Express.js / Node.js             │◄──►│     Delhivery B2C      │
│  React + Vite + TW v4  │    │            TypeScript Backend                │    │ Express Logistics API  │
│  Port 5173 (Prod CDN)  │    │                Port 3000                     │    │ (Labels, AWB, NDR, QC) │
└────────────────────────┘    └──────────────┬────────────────┬──────────────┘    └────────────────────────┘
                                             │                │
                                             ▼                ▼
                              ┌─────────────────────┐  ┌─────────────────────┐
                              │   PostgreSQL 17     │  │   Firebase Storage  │
                              │ (Hostinger VPS /    │  │  & Resend Email     │
                              │  Prisma 5.22 ORM)   │  │  (POD/Labels/Logo)  │
                              └─────────────────────┘  └─────────────────────┘
```

- **Backend**: Node.js 20+, Express, TypeScript, Prisma ORM (`prisma/schema.prisma`), PostgreSQL 17.
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide icons (`frontend/`).
- **Logistics**: Delhivery Express B2C API (`src/modules/delhivery/`), custom shipping label renderer, document fetcher.
- **E-Commerce**: Shopify Dev Dashboard App (OAuth client credentials grant, automated token caching & renewal).
- **Communication & Storage**: Resend transactional emails (`src/modules/email/`), Firebase Admin SDK & Cloud Storage bucket (`src/modules/firebase/`).

---

## 3. Strict Invariants & Non-Negotiable Rules

### A. Strict Date Cutoff (25-09-2026)
- **Rule**: Only orders created on or after **`2026-09-25`** are synchronized, processed, or dispatched.
- **Rationale**: Historical orders before this date belong to prior operational workflows and must never be auto-dispatched or altered.
- **Guarded in**: `order.service.ts`, `shopify.service.ts`, and API sync endpoints.

### B. Side-Effect Import in `src/index.ts`
- **Rule**: `src/index.ts` must use side-effect import `import './app';`.
- **Warning**: Do NOT change to `import app from './app'` or TypeScript compiler tree-shaking will eliminate the import and the Node process will terminate immediately with code 0.

### C. Dispatch State Transition (PR #11)
- When a Delhivery AWB is generated:
  - The order status must be promoted from `DISPATCH_PENDING` / `NEW` to **`DISPATCHED`**.
  - The shipment status must be promoted to **`IN_TRANSIT`** (or `AWB_ASSIGNED`).
  - An audit timestamp **`dispatchedAt`** is written to the order.
  - The tracking cron polls `PENDING`, `CREATED`, and `IN_TRANSIT` shipments so tracking updates flow continuously.

### D. Delhivery Package Dimensions & Freight Slab (PR #8)
- Every shipment creation request sends explicit package dimensions to prevent courier overcharging:
  - **Single item**: `22 × 20 × 3 cm`
  - **Multi item (2+ unique lines)**: `22 × 20 × 5 cm`
  - **Declared weight**: `500 g` (capped under Delhivery's 500g threshold to maintain base tier).
  - Configurable via environment variables in `src/config/index.ts`.

### E. Shipping Label Standards (PR #4, #6, #12)
- **Dimensions**: Thermal 4R (`4 in × 6 in` / `100 mm × 150 mm`).
- **Official PDF & Multi-shape Extraction**: The system queries Delhivery's packaging label API and handles multiple response shapes (`packages_found` array, `packages` object, or root URL).
- **HTML Fallback**: If Delhivery's external PDF URL returns 404 or fails, the backend renders a pixel-perfect, thermal-ready HTML printable label containing the authentic layout, barcodes, routing code, and the horizontal Youthnic logo.

### F. Brand Identity & Email Notifications (PR #8, #9, #10)
- Sender badges must be clean, lowercase email identities (`delivery@youthnic.com`, `returns@youthnic.com`, `refunds@youthnic.com`, `support@youthnic.com`).
- The Youthnic logo is hosted on Firebase Storage (`https://storage.googleapis.com/.../public/youthnic-logo.png`) rather than inline base64 to ensure universal rendering across Outlook desktop, Apple Mail, and Gmail.
- AWB tracking numbers use a clean monospace font stack (`JetBrains Mono`, `SF Mono`, `Menlo`, `Consolas`).

### G. Database Schema & Deployment (Commit `3829719`)
- Before building the application in CI/CD or production containers, execute `npx prisma db push --accept-data-loss`.
- This ensures additive schema changes (such as `dispatchedAt`, `qcStoragePath`, `labelStoragePath`) exist in PostgreSQL before the generated Prisma client executes queries.

---

## 4. Summary of Recent Agent Developments (PR #1 to PR #12)

| PR / Commit | Component | Summary of Implementation |
|---|---|---|
| **PR #1** (`a65d8e5`) | Orders & API | Channel order ingestion, authenticated label and invoice download endpoints, UI status badges. |
| **PR #2** (`62cdc64`) | Delhivery & Shopify | Linked Delhivery One `youthnic2024` channel, canceled premature fulfillments, hardened 25-Sep cutoff. |
| **PR #3** (`9fead8c`) | Security | Enforced end-to-end HTTPS, 301 redirects on client/server, CSP `upgrade-insecure-requests`, strict Firebase token auth. |
| **PR #4** (`c147bf8`) | Labels & Manifest | Integrated horizontal Youthnic logo on shipping label, authentic Delhivery 4R layout, official PDF fetch, and manifest validation. |
| **PR #5** (`a252037`) | Cloud Storage & CI | Mirrored POD, QC sorter images, and labels to Firebase Storage; implemented Delhivery Document Fetcher service; added Vitest test suite and GitHub Actions PR workflow. |
| **PR #6** (`a077343`) | Label Testing | Pinned shipping label size to thermal 4R (4" x 6") with dedicated unit tests and Vitest mock setup. |
| **Deploy** (`3829719`) | CI/CD Deploy | Added `prisma db push` step in `.github/workflows/deploy.yml` before build to eliminate database drift. |
| **PR #7** (`684adca`) | Frontend UX | Overhauled the floating bulk-action toolbar in Orders page with clear visual hierarchy, active counters, and modern buttons. |
| **PR #8** (`2278035`) | Brand & Logistics | Rebranded email templates with Youthnic design; optimized package dimensions (22x20x3cm / 22x20x5cm @ 500g). |
| **PR #9** (`e51ec4e`) | Email Assets | Hosted Youthnic logo on Firebase Storage at `public/youthnic-logo.png` to fix Outlook base64 image dropping. |
| **PR #10** (`832bc2d`) | Email Migration | Completed email brand migration; standardized all template sender badges to lowercase; unified dynamic `fromEmail` config. |
| **PR #11** (`048d2ec`) | Dispatch State Machine | Promoted orders and shipments out of `DISPATCH_PENDING` upon AWB generation; added `dispatchedAt` audit timestamp; updated tracking cron to poll pending shipments. |
| **PR #12** (`4d74b4b`) | Label Resiliency | Added multi-shape PDF extraction for Delhivery label API responses and an HTML printable fallback for 404 resilience. |

---

## 5. Development & Testing Commands

```bash
# 1. Run all Vitest unit tests (38 tests)
cmd.exe /c "npm test"

# 2. Typecheck and build backend
cmd.exe /c "npm run build"

# 3. Typecheck and build frontend
cmd.exe /c "cd frontend && npm run build"

# 4. Sync Prisma schema to database (dev/staging)
npx prisma db push

# 5. Run backend development server (Port 3000)
cmd.exe /c "npm run dev"

# 6. Run frontend development server (Port 5173)
cmd.exe /c "cd frontend && npm run dev"
```
