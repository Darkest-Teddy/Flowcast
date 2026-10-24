---
inclusion: fileMatch
fileMatchPattern: "web/src/lib/fatigue.ts"
---

# Fatigue model rules

- All constants go in `FATIGUE_ASSUMPTIONS`. A magic number anywhere else in the file is a bug.
- Changing `stepMinutes` must not change results by more than 2% (Requirement 3.2). Use exact solutions, not Euler steps.
- When you change behavior, update `.kiro/specs/student-fatigue/` in the same change: the acceptance criterion in `requirements.md`, the equation table in `design.md`, and the checkbox in `tasks.md`.
- Use the calibration skill in `.kiro/skills/fatigue-calibration/` before changing a rate constant.
