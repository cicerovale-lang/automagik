# Automagik RFCs

An RFC here is a short design for one open decision surface: something that needs a decision
before code, sets a public contract, or adds a trust boundary. Work that is already scoped as an
issue ships as a plain fix and needs no RFC.

## Status values

| Status | Meaning |
|---|---|
| Draft | Written, not yet scheduled. Its open questions wait for the owner. |
| Accepted | Scheduled by the owner. Its deliveries are filed and built in milestone order. A question left open is answered before the delivery it blocks. |
| Shipped | Every delivery merged. The RFC is kept as the record of the design. |
| Parked | Not scheduled. It keeps its number and can be picked up again. |

## Process

1. An RFC lands as docs only. Every commit in the PR is typed `docs(rfcs): ...`, so the merge
   cuts no release (see [0001](0001-roadmap-and-milestones.md)).
2. The owner schedules it and answers the questions that block it. The RFC moves to Accepted.
3. Each delivery becomes one issue under an outcome-named milestone, and one PR that closes it.
   A delivery is small, complete for users at merge (or hidden behind a setting), and on one
   release lane: plugin-only (3.N.P) or desktop (3.N). A PR never mixes the two.
4. When the last delivery merges, the RFC moves to Shipped.

Security gaps are named by title only until their fix merges. Details go to a private advisory.

## Index

| # | Title | Status | Milestone |
|---|---|---|---|
| [0001](0001-roadmap-and-milestones.md) | Roadmap and milestones | Accepted | n/a (process) |
| [0002](0002-browser-group-1-completion.md) | Browser Group 1 completion | Accepted | 1. Safe browser and everyday fixes |
| [0003](0003-model-routes-and-acp.md) | Model routes and ACP | Accepted | 2 (route descriptor), 3. Other agents in the same chat |
| [0004](0004-composer-chat-kinds.md) | Composer and chat kinds | Accepted | 2. One message box |
| [0005](0005-workspace-and-genie-projects.md) | Workspace and Genie projects | Accepted | 4. Projects in one place (Publish not scheduled) |
| [0006](0006-herdr-terminal-mode.md) | Herdr terminal mode | Draft | not scheduled |
| [0007](0007-desktop-speed.md) | Desktop speed | Accepted | 1 (marks, stable port), 5. The app opens fast |
| [0008](0008-platform-and-web-instances.md) | Platform and web instances | Draft | not scheduled |
| [0009](0009-personal-customization.md) | Personal customization | Draft | after 2 (proposed: Make it yours) |
| [0010](0010-desktop-sandbox.md) | Desktop sandbox and supervision | Draft | not scheduled |
| [0011](0011-monorepo-parts-and-releases.md) | Monorepo parts and releases | Accepted | n/a (process) |
| [0012](0012-am-cli-and-parts.md) | am, one CLI and parts | Draft | not scheduled |
| [0013](0013-work-code-switch.md) | The work and code switch | Draft | not scheduled |
| [0014](0014-shared-bot-registry.md) | Shared Bot registry | Draft | not scheduled |
| [0015](0015-live-chat-projection.md) | Live chat projection | Draft | not scheduled |

Milestones, in the owner's order:

1. Safe browser and everyday fixes
2. One message box
3. Other agents in the same chat
4. Projects in one place
5. The app opens fast

Personal customization (0009) is scheduled after milestone 2; it is Draft until then. Herdr,
Genie Publish, Platform, Desktop sandbox, `am` and parts, the work and code switch, the shared
Bot registry and the live chat projection stay at the RFC stage until their questions are
answered.
Milestones and one issue per delivery are created after the PR that lands these RFCs merges.

### Fixes without an RFC

These ship as plain issue fixes in milestone 1, "Safe browser and everyday fixes".

| Issue | Fix |
|---|---|
| #120 | Task workers start at the Bot's level (see below). |
| #88, #91 | The composer's two-row layout and the queue dock overlap. 0004 builds on it. |
| #153 | The model dock crash. It ships before 0004's picker slice. |
| #141 | Drafts lost when the localhost origin changes. Fixed by 0007's stable-port slice. |

**Task workers start at the Bot's level (#120).** Today a task session starts at a fixed level,
not at its Bot's. The fix starts a worker or a wish at `min(requested level, Bot's level)`. A
caller can lower the level but never raise it. A worker never starts at Full access unless the
owner chose Full access for that Bot. When a level that never asks rejects an approval on its
own, the owner sees a notice; it is not dropped silently. If the Genie plugin passes its own
level when it starts a task, the matching change in the Genie repository is tracked by a linking
issue (see 0001).

## Template

Copy this into `NNNN-short-name.md`. Keep it to about 60-150 lines.

```markdown
# RFC NNNN: Title

| Field | Value |
|---|---|
| Status | Draft |
| Milestone | outcome name |
| Lanes | plugin (3.N.P), desktop (3.N) |
| Created | YYYY-MM-DD |

## Summary
Two to four sentences: what changes for users, and what it decides.

## Motivation
The problem, who has it, and the issues it links.

## Design
What is built. Plain sentences, no code dumps.

## Contracts introduced
Every public id, route, path and storage key this RFC creates or changes.
For each one, the compatibility rule for existing installs.

## Threat model
Required when the RFC adds a trust boundary. Who can reach it, what it can do,
how it is authenticated, and how to undo it.

## Deliveries
Numbered slices. Each one says:
- release lane: plugin-only (3.N.P) or desktop (3.N);
- acceptance check: the one test or observation that proves it;
- rollback: what reverting the release does, and what it cannot undo.

## Open questions
Each question with a recommended answer.

## Links
Issues, PRs and other RFCs.
```
