# Enrollment model comparison

Reproduce the current metrics with `node map-client/scripts/audit-enrollment.mjs`. Both runs use the same saved course schedules and institutional roster; the baseline already includes physical-room capacity limits. Memberships are unique student/course/section combinations across the entire week, not daily attendance counts.

| Check | Before | After |
| --- | ---: | ---: |
| Undergraduate memberships in 600+ courses | 19,217 (25.0%) | 0 (0.0%) |
| Graduate memberships in ordinary 100–399 courses | 26,194 (55.0%) | 0 (0.0%) |
| Students taking three or more courses across three or more schools | 19,782 (72.7%) | 707 (2.5%) |
| Total student-section memberships | 124,604 | 127,291 |
| Simulated students | 36,977 | 36,977 |

Course-level defaults follow the [BU Bulletin](https://www.bu.edu/academics/bulletin/abbreviations-and-symbols/). Mixed-level aliases retain one shared physical seat pool. Professional MD and graduate-school exceptions prevent low-numbered graduate courses from being treated as undergraduate courses. The [Registrar guide](https://www.bu.edu/reg/registration/abbreviations/) differs for 400-level courses, so the broader Bulletin allowance is retained. [PDP became noncredit in Fall 2024](https://www.bu.edu/fitrec/2024/02/27/fall-2024-changes-to-physical-education-pdp-program-offerings/); PDP and 000–099 offerings do not count as degree-load courses.

School affinity is a synthetic preference, not a measured major. The lower cross-school fraction demonstrates that the preference is applied; it is not a measured error reduction. Primary campus allocation now uses degree-eligible, deduplicated weekly offerings. With housing held fixed, modeled Medical undergraduate primary assignments fall from 1,176 to zero and graduate assignments rise from 1,429 to 1,859; Fenway retains 595 residents. These are model allocations, not measured campus headcounts. Medical FTE is contextual evidence and is not multiplied into a headcount estimate.

All 6,944 saved physical meeting records have unknown enrollment. Room seats remain upper bounds, not registrations or attendance. Program-specific admission, prerequisites, individual permissions, linked lecture/lab requirements, online-only enrollment, and actual majors are not recovered by these changes. Reported section fill fractions in the JSON are diagnostics only; cross-listing alias splits also affect that metric. Noncredit registrations are not inferred by the degree planner. No new people or observed traffic counts were invented.
