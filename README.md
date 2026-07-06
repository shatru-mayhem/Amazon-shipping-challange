# ASCS Portal — Landing Page & Portal Previews

Dual-entrance landing page for Amazon Supply Chain Services, built from
`landpage.md` with the Amazon corporate design system from `design.md`.

## Run

    npm install
    npm run dev

Open http://localhost:3000

## Routes

- `/` — Landing page: dual entrance (Client Portal / Amazon Employee Portal)
  with mock code-access login + email confirmation.
- `/client` — Client Portal preview: Digital Twin Pipeline (approval points +
  issue flags), categorized Q&A, document upload by category, progress
  tracker (Uploaded → Viewed → Reviewed → Answered), project switcher.
- `/employee` — Employee Portal preview: hierarchy-based access (demo level
  switch), restricted document review folders, filtered Q&A answer bar,
  proposal chat surfacing Risks / Opportunities / Costs, challenge brief &
  client evaluation checklist.

## Notes

- All data is mock data, labeled `// MOCK DATA - TO BE REPLACED BY DB FETCH`.
- Auth is a UI mock; input ports are kept open for real API integration.
- Stack: Next.js 14 (App Router), TypeScript (strict, no `any`), Tailwind
  with Amazon semantic tokens (ink/navy/orange/link blue, 4–8px radii).
- Per `agents.md`, a public landing page is out of PRD v1 scope; this was
  built on explicit user instruction using `landpage.md` as the spec.
