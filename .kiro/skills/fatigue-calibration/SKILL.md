---
name: fatigue-calibration
description: How to change a constant in the Flowcast fatigue model and check the effect. Use when tuning loadPerHour, rush penalty, decay or weights in web/src/lib/fatigue.ts.
---

# Calibrating the fatigue model

1. Write down why the new value is better and where it comes from (paper, survey, team judgment). Put that reason in a comment next to the constant.
2. Run the sweep before and after the change and compare peak and mean for the three reference days:

   ```bash
   node web/scripts/fatigue-sweep.ts
   ```

3. Expected ordering, which must still hold after any change: rest day < typical day < packed day, by mean score.
4. Run `node --test web/tests/fatigue.test.ts`.
5. Update the equation table in `.kiro/specs/student-fatigue/design.md` if an equation or its source changed.

Do not tune constants to make a demo look dramatic. The Responsibility & Ethics score depends on the assumptions being honest.
