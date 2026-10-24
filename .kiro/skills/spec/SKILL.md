---
name: spec
description: Start or continue a spec-driven feature in .kiro/specs (requirements, design, tasks).
---

# Spec-driven feature

Feature: $ARGUMENTS

1. If `.kiro/specs/<feature>/` doesn't exist, read the relevant parts of `.plans/campus-digital-twin-spec.md` and the code, then write:
   - `requirements.md`: user stories with numbered EARS criteria (WHEN … THEN … SHALL).
   - `design.md`: data flow, key decisions and the assumptions the feature adds.
   - `tasks.md`: checkbox tasks, each traceable to requirement numbers.
   Stop and ask the user to approve the requirements before implementing.
2. If it exists, read all three files, pick the first unchecked task, implement it, verify it with tests, then tick it.
3. Never tick a task without test or build output that shows it works.
