# ASCS Opportunity Assistant: Programming & Engineering Standards

## 1. Introduction & Purpose
This document serves as the homogenous engineering guide for the **ASCS Opportunity Assistant** hackathon project. Because multiple developers and AI models (including Claude Code, Gemini, and others) are contributing to this codebase concurrently, strict adherence to these standards is mandatory. 

The goal is to ensure a unified architecture, prevent GitHub merge conflicts, and maintain the precise scope outlined in the `PRD.md` and `design.md` files. All AI agents must read and abide by these definitions before writing or modifying code.

---

## 2. Core Languages & Tech Stack Definitions

To maintain consistency, the tech stack is strictly limited to the following definitions:

### TypeScript (Primary Language)
* **Definition:** A strongly typed superset of JavaScript. 
* **Usage Rule:** All files must be `.ts` or `.tsx`. `any` types are strictly forbidden. Interfaces and types must map directly to the Data Model entities defined in the PRD (e.g., `User`, `Opportunity`, `Assessment`).
* **Why:** Ensures that AI models and human devs catch data structure mismatches at compile time rather than runtime.

### Next.js (App Router)
* **Definition:** A React framework for building server-rendered and statically generated web applications.
* **Usage Rule:** The project utilizes the Next.js App Router (`/app` directory). 
* **Server vs. Client Components:** * Default to **Server Components** for data fetching, backend logic, and layout structures.
    * Use **Client Components** (via `"use client";` directive at the top of the file) *only* when interactivity (e.g., React hooks like `useState`, `onClick` events) is explicitly required, such as in the Intake Form or Evidence Drawer.

### Tailwind CSS / Design Tokens
* **Definition:** A utility-first CSS framework.
* **Usage Rule:** Follow the strict Amazon corporate styling defined in `design.md`. Do NOT invent AI-style gradients or neon colors. Use semantic tokens (e.g., Amazon Navy, Amazon Orange).

---

## 3. Core Software Engineering Concepts

When prompting AI models to generate code, align with these architectural concepts:

### Functions & Server Actions
* **Pure Functions:** Utility functions should be pure (given the same input, they always return the same output without side effects). Keep business logic separate from UI rendering.
* **Next.js Server Actions:** For AI integration (e.g., generating the decision memo or capability map), use Next.js Server Actions. This ensures API keys and prompt logic remain securely on the server and are never exposed to the browser client.
* **Single Responsibility Principle:** A function should do exactly one thing. If an AI generates a function longer than 50 lines, prompt it to refactor into smaller helper functions.

### Component Architecture
* **Modularity:** Build small, highly specific components (e.g., `<StatusBadge />`, `<OpportunityTableRow />`, `<EvidenceDrawer />`).
* **Prop Drilling vs. Context:** Keep component trees shallow. Pass props directly for 1-2 levels. For global state (like the current active Opportunity), consider a lightweight context provider.
* **UI Constraints:** Adhere to dense, enterprise-first desktop layouts. Do not use generic component libraries if they conflict with the 4-8px radius and Amazon corporate requirements.

### Data Models (Schema Definition)
All code must reference the approved entities from `PRD.md`. Do not invent new database tables or relationships.
1.  **User:** id, name, email, role, team.
2.  **Opportunity:** id, company_name, industry, owner_id, status.
3.  **IntakeProfile:** current_model, volume_band, parcel_profile, etc.
4.  **Assessment:** ascs_fit_band, amazon_shipping_role.
5.  **Recommendation:** band, rationale, ascs_configuration.
6.  **DecisionMemo:** generated output for handoff.
7.  **AuditEvent:** tracking AI outputs and user overrides.

---

## 4. GitHub & Version Control Strategies (Preventing Clashes)

Because multiple AI agents will be writing code rapidly during the hackathon, follow these Git protocols to prevent "version clashes":

1.  **Component Isolation (Branching):**
    * Work on isolated branches strictly tied to specific features (e.g., `feature/intake-form`, `feature/decision-memo`).
    * Do not have two agents working on the same file concurrently. Map out file ownership before initiating coding loops.
2.  **Atomic Commits:**
    * Instruct AI to write atomic commits. A commit should do *one* thing (e.g., "Add User interface", not "Add User interface and build Dashboard and update CSS").
3.  **Merge Conflict Mitigation:**
    * Keep files small (under 200 lines). If a file grows large, it increases the surface area for conflicts. Refactor into sub-directories.
    * Always pull the latest `main` branch before asking an AI to modify existing code. Provide the AI with the *current* state of the file, not an outdated version.

---

## 5. Directives for AI Agents (Claude Code, etc.)

When interacting with the codebase, all AI agents must follow these operational rules:

* **Rule 1: Read Before Writing.** Always parse `PRD.md` and `design.md` before generating code. Understand the product principles (e.g., "no automated pricing", "Amazon Shipping is just the last-mile component").
* **Rule 2: No Placeholders.** If data is mocked, label it explicitly as `// MOCK DATA - TO BE REPLACED BY DB FETCH`.
* **Rule 3: Avoid Hallucinations in the UI.** Do not add extra pages (like a public marketing landing page) that are explicitly marked "Out of Scope" in the PRD. 
* **Rule 4: Explicit AI Auditing.** Ensure any code generating recommendations explicitly tags it as AI-generated in the `AuditEvent` schema, preserving the "human-in-the-loop" decision ownership required by the business developer.
