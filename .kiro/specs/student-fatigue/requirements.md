# Requirements Document

## Introduction

Flowcast agents follow schedules but have no internal state. This feature adds a per-agent fatigue score so the simulation can show which schedules wear students down and when campus-wide exhaustion peaks. The score is a model-derived projection from stated assumptions, consistent with the master plan's rule that numeric behavior settings are defaults, not validated measurements (`.plans/campus-digital-twin-spec.md`, introduction and Section 10.2).

## Requirements

### Requirement 1: Fatigue curve per student

**User Story:** As a student who joined from my phone, I want to see how tiring my day is, so that I can spot the hours where I should take a break.

#### Acceptance Criteria

1. WHEN the model receives a schedule, a location list, a wake time and an end time THEN the system SHALL return one fatigue sample per step from wake time to end time inclusive.
2. WHEN a sample is produced THEN the system SHALL report the combined score clamped to 0–1, and its sleep-pressure, circadian and activity-load components.
3. WHEN the student is inside a schedule item at a sample time THEN the system SHALL attach that item's ID to the sample.
4. WHEN the end time is at or before the wake time THEN the system SHALL return an empty curve.
5. IF the wake time or end time is not a valid ISO date THEN the system SHALL throw an error naming the invalid inputs.

### Requirement 2: Activity and transitions affect fatigue

**User Story:** As a campus planner, I want back-to-back classes across campus to show up as more tiring, so that I can compare schedule scenarios.

#### Acceptance Criteria

1. WHEN a student spends time at a classroom, library, gym or venue THEN the system SHALL increase activity load at that location kind's stated rate.
2. WHEN a student spends time at a dining hall or dorm THEN the system SHALL decrease activity load.
3. WHEN two consecutive items are at different locations with a gap shorter than the rush threshold THEN the system SHALL add a rush penalty and count the transition.
4. WHEN schedule items overlap THEN the system SHALL sum their load rates.
5. WHEN an item references a location the model does not know THEN the system SHALL add no load for it.
6. WHEN a suggested item has not been accepted THEN the system SHALL ignore it.

### Requirement 3: Stated, reproducible assumptions

**User Story:** As a judge scoring Responsibility & Ethics, I want every fatigue constant written down in one place, so that I can see the model is an assumption set and not a claim about real students.

#### Acceptance Criteria

1. THE system SHALL define every numeric constant in a single exported assumptions object.
2. WHEN the caller changes the step size THEN the activity-load result at a given time SHALL change by less than 2%.
3. WHEN the same inputs are given twice THEN the system SHALL return identical output.
4. THE system SHALL NOT store or transmit any fatigue score outside the student's own session.
