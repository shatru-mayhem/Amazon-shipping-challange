# Server Actions — Backend Map (webdev.md features)

| File | Feature | Actions |
|---|---|---|
| auth.ts | 1. Dual-entrance auth & RBAC | requestLoginCode, verifyLoginCode, signOut, getCurrentProfile |
| opportunities.ts | 2. Opportunity & intake pipeline | createOpportunity, updateIntake, getDigitalTwin, listOpportunities |
| documents.ts | 3. Secure document management | uploadDocument, listDocuments, getDocumentUrl |
| qna.ts | 4. Categorized Q&A | askQuestion, listQuestionsForEmployee, updateQuestionStatus, answerQuestion |
| proposal.ts | 5. AI/LLM orchestration (stub) | evaluateOpportunity — deterministic, typed JSON; swap point marked |
| audit.ts | 6. Audit trail | logAuditEvent, withAudit |

Role routing (Feature 1) also lives in `middleware.ts` at the project root.

All actions: validate input → check auth → RLS-scoped Supabase query → audit
critical mutations → revalidate affected routes. Errors return
`{ ok: false, error }` — never thrown across the client boundary.
