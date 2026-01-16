# Patient App Logic

## 1. Booking Workflows

### A. Walk-in Booking (Instant)
Walk-in booking constitutes the majority of patient flow. It is designed for patients who are physically present at the clinic.

**Core Rules:**
1.  **Session-Locked**: A walk-in booking is always tied to the *current* or *next immediate* active session. It cannot be booked for a distant future date.
2.  **Sequential Slot Allocation**:
    - The system first checks for **Empty Slots** in the schedule (e.g., due to a cancellation).
    - If no empty slots exist, it looks for the **Spacing Interval** (a predefined buffer, e.g., every 5th slot).
    - If no spacing slots are available, it appends the patient to the **End of the Queue**.
3.  **Token Generation**:
    - Walk-in tokens always start with **'W'** (e.g., `W001`).
    - The numeric part is determined by: `(Total Slots + Daily Counter + 100)`.
    - **Why +100?** To visually distinguish them from online appointments (which might be `A001`).

### B. Advanced Booking (Online)
Advanced booking allows patients to reserve a specific time slot for future dates.

**Core Rules:**
1.  **Capacity Limits**:
    - A maximum of **85%** of a session's *future* slots can be booked online.
    - The remaining **15%** is strictly reserved for walk-ins to ensure the clinic never says "Full" to a physical patient while empty slots technically exist.
2.  **Date & Session Selection**:
    - Patients select a specific session (e.g., "Morning").
    - The system calculates available slots based on the doctor's `averageConsultingTime` (default 15 mins).
3.  **Token Generation**:
    - Online tokens start with **'A'** followed by the Session Index (e.g., `A1-005` for Session 1, `A2-005` for Session 2).
    - This allows strict segregation of queues per session.

## 2. Token Numbering System
The system uses a "Hybrid Token" approach:
- **Sequential**: Everyone gets a predictable number.
- **Session-coded**: `A1`, `A2` prefixes tell the security guard exactly which session the patient belongs to preventing overcrowding in the morning for an evening slot.
- **Conflict-Free**: The system uses atomic database counters to ensure two people never get the same token, even if they hit "Book" at the exact same millisecond.

## 3. Availability Logic
Before showing a slot to a patient, the system runs a multi-step check:
1.  **Doctor Schedule**: Is the doctor working that day?
2.  **Leaves**: Has the doctor marked a "Leave" for that specific slot?
3.  **Breaks**: Is there a coffee/lunch break scheduled?
4.  **Capacity**: Have we hit the 85% online booking limit?

If *any* of these checks fail, the slot is hidden or marked "Unavailable".
