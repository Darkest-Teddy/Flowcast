# Building behavior audit

Run: `node map-client/scripts/audit-buildings.mjs` (Node 26). Uses saved datasets; no scraping.

All 50 mapped locations, Monday–Sunday of the source reference week. Peaks use exact stay boundaries, not sampled snapshots. Population: 36977.

Classroom capacities are room-seat references, not whole-building occupancy limits. Optional venue capacities remain modeling assumptions where no published capacity exists. Estimated profiles fill gaps using existing students, purpose-specific schedules, and estimated housing allocations; their metadata is included in JSON. These are low-confidence estimates, not observed attendance. Fenway housing estimates distribute the existing planned relocation cohort rather than adding people.

| Location | Coverage | Reference capacity | Weekly peak | Class assignments | Optional visits | Minutes above reference | Visits outside hours |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Warren Towers (Tower A) | Partial model | 600 | 600 | 0 | 0 | 0 | 0 |
| Myles Standish Hall | Partial model | 730 | 730 | 0 | 0 | 0 | 0 |
| Student Village | Partial model | 802 | 802 | 0 | 0 | 0 | 0 |
| Claflin Hall | Estimated | 600 | 570 | 0 | 0 | 0 | 0 |
| Kilachand Hall | Partial model | 198 | 131 | 443 | 0 | 0 | 0 |
| College of Arts and Sciences | Partial model | 2817 | 2290 | 65404 | 0 | 0 | 0 |
| Computing & Data Sciences | Partial model | 632 | 516 | 11610 | 0 | 0 | 0 |
| Questrom School of Business | Partial model | 1924 | 1637 | 32656 | 0 | 0 | 0 |
| Photonics Center | Partial model | 948 | 577 | 11608 | 0 | 0 | 0 |
| Engineering Product Innovation Center | Partial model | 609 | 506 | 9662 | 0 | 0 | 0 |
| Mugar Memorial Library | Partial model | 800 | 797 | 1021 | 20741 | 0 | 0 |
| Pardee Library | Partial model | 200 | 200 | 0 | 4520 | 0 | 0 |
| George Sherman Union | Partial model | 600 | 250 | 0 | 1748 | 0 | 0 |
| Warren Towers Dining Hall | Partial model | 500 | 314 | 0 | 3820 | 0 | 0 |
| Agganis Arena | Estimated | 1500 | 120 | 0 | 600 | 0 | 0 |
| Fitness and Recreation Center | Partial model | 1200 | 423 | 72 | 10124 | 0 | 0 |
| DeWolfe Boathouse | Estimated | 150 | 54 | 0 | 375 | 0 | 0 |
| Student Village 2 (33 Harry Agganis Way) | Partial model | 960 | 960 | 0 | 0 | 0 | 0 |
| Rich Hall | Estimated | 600 | 570 | 0 | 0 | 0 | 0 |
| Sleeper Hall | Estimated | 600 | 570 | 0 | 0 | 0 | 0 |
| West Campus Dining Hall | Partial model | 840 | 448 | 0 | 5423 | 0 | 0 |
| 1019 Commonwealth Avenue | Estimated | 300 | 270 | 0 | 0 | 0 | 0 |
| The Towers | Partial model | 521 | 521 | 0 | 0 | 0 | 0 |
| 575 Commonwealth Avenue | Estimated | 550 | 495 | 0 | 0 | 0 | 0 |
| Danielsen Hall | Estimated | 200 | 180 | 0 | 0 | 0 | 0 |
| Marciano Commons | Partial model | 920 | 375 | 0 | 4690 | 0 | 0 |
| School of Law (Law Tower) | Partial model | 1530 | 936 | 11756 | 0 | 0 | 0 |
| College of Communication | Partial model | 903 | 695 | 11213 | 0 | 0 | 0 |
| College of Fine Arts | Partial model | 1924 | 909 | 14990 | 0 | 0 | 0 |
| College of General Studies | Partial model | 1555 | 782 | 15308 | 0 | 0 | 0 |
| Sargent College of Health & Rehabilitation Sciences | Partial model | 615 | 483 | 6196 | 0 | 0 | 0 |
| College of Engineering (110 Cummington Mall) | Partial model | 90 | 90 | 710 | 0 | 0 | 0 |
| Medical Student Residence | Estimated | 208 | 177 | 0 | 0 | 0 | 0 |
| Chobanian & Avedisian School of Medicine Instructional Building | Partial model | 1338 | 604 | 6569 | 0 | 0 | 0 |
| School of Public Health (Talbot Building) | Estimated | 500 | 87 | 0 | 1000 | 0 | 0 |
| Henry M. Goldman School of Dental Medicine | Estimated | 400 | 95 | 0 | 800 | 0 | 0 |
| Center for Advanced Biomedical Research | Estimated | 200 | 80 | 0 | 498 | 0 | 0 |
| Silvio O. Conte Medical Research Center | Estimated | 150 | 60 | 0 | 374 | 0 | 0 |
| Alumni Medical Library | Partial model | 250 | 93 | 0 | 1493 | 0 | 0 |
| Chequers Cafe | Partial model | 120 | 102 | 0 | 1985 | 0 | 0 |
| Riverway House | Estimated | 120 | 108 | 0 | 0 | 0 | 0 |
| Longwood House | Estimated | 70 | 63 | 0 | 0 | 0 | 0 |
| Pilgrim House | Estimated | 80 | 72 | 0 | 0 | 0 | 0 |
| Campus Center & Student Residence | Estimated | 108 | 97 | 0 | 0 | 0 | 0 |
| Fenway Campus Dining Hall | Partial model | 250 | 103 | 0 | 3937 | 0 | 0 |
| FitRec at Fenway | Partial model | 30 | 30 | 0 | 610 | 0 | 0 |
| Peabody Hall | Estimated | 134 | 121 | 0 | 0 | 0 | 0 |
| Fenway Classroom Building | Estimated | 300 | 43 | 0 | 700 | 0 | 0 |
| Fenway Activities Building | Estimated | 400 | 30 | 0 | 450 | 0 | 0 |
| Hawes Building (Wightman Mansion) | Estimated | 60 | 16 | 0 | 200 | 0 | 0 |

Assignments and visits count attendance episodes across the week, not distinct people. JSON includes capacity basis, estimate assumptions, and peak time for every location. Outside-hours checks use published windows for sourced activities and explicitly estimated windows for estimated activities.
