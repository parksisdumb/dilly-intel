# Dilly Intel — Claude Code Project Brief

## What This Is
Dilly Intel (dillyintel.com) is the commercial property 
intelligence layer. SEPARATE product from Dilly (DILLYV2).

North Star: Give commercial contractors complete market 
intelligence about every commercial property in their 
territory so they never make a blind cold call again.

## The Architecture
Dilly Intel = intelligence layer (this repo)
- Owns ALL commercial property data
- Runs ALL discovery and enrichment agents
- Provides web interface for market research
- Users search, select accounts, push to Dilly

Dilly BD OS = execution layer (DILLYV2 repo, separate)
- Reps call, log outcomes, track pipeline
- Receives accounts pushed from Dilly Intel
- Never runs agents directly

## Tech Stack
- Framework: Next.js 15, App Router ONLY
- Database: Supabase (SEPARATE project from Dilly)
- Auth: Supabase Auth
- Styling: Tailwind CSS v4
- Language: TypeScript throughout
- Agents: Inngest
- AI: Anthropic SDK (claude-sonnet-4-5)

## Critical Rules
- NEVER import from or depend on DILLYV2
- ALL agent logic lives HERE not in Dilly
- intel_* tables: NO RLS, service role only
- User tables (users, orgs, icp_profiles): RLS enabled
- Dev server runs on port 3001 (not 3000)

## User Flow — Build Everything Around This
1. Sign up / log in
2. Complete ICP questionnaire (markets + targeting)
3. See market intelligence dashboard
4. Search and explore properties and accounts
5. Select what they want to pursue
6. Push to Dilly with one click
7. Dilly handles the execution from there

## Database Tables
intel_properties — every commercial property we know about
intel_entities — REITs, corporations, PM companies
intel_contacts — decision makers
intel_prospects — enriched business records
agent_runs — agent execution history
agent_registry — agent config and schedules
users — Dilly Intel accounts
orgs — organizations
icp_profiles — user targeting preferences
push_log — tracks everything pushed to Dilly

## What NOT To Build Here
- No CRM features (that is Dilly's job)
- No auto-assignment of prospects
- No synchronous agent runs triggered by users
- Nothing that belongs in the Dilly BD OS
