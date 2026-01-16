# Clinic Operations Logic

## 1. Queue Management
The "Nurse Station" is the command center for the clinic. It manages three distinct queues:

### A. Arrived Queue (The "Active" List)
- **Definition**: Patients who have been marked as "Arrived" by the nurse.
- **Sorting**: Strictly by **Appointed Time**.
    - If a 10:00 AM patient arrives at 10:05, they are placed *before* a 10:15 AM patient.
    - **Walk-in Handling**: Walk-ins are interwoven based on their generated slot time.

### B. Buffer Queue (The "On Deck" Circle)
- **Definition**: The top 2-3 patients from the Arrived Queue.
- **Purpose**: These patients are told to "Stand by near the door".
- **Logic**: The system automatically pulls the top available patient into this buffer.

### C. Skipped Queue (The "Penalty" Box)
- **Definition**: Patients who were called but didn't show up.
- **Re-insertion**: If a skipped patient returns, they are not placed at the top. They are re-inserted *after* the current buffer to avoid disrupting flow.

---

## 2. Session & Status Management

### A. Doctor Status (In / Out)
- **In**: The doctor is physically in the cabin. The queue moves.
- **Out**: The doctor is away. The specific "Break Logic" activates (see below).
- **Automation**: The system *used to* auto-mark doctors as "Out" based on time, but this was removed in favor of strict **Manual Control** to match ground reality.

### B. Breaks (Coffee / Lunch)
When a doctor takes a break:
1.  **Shift vs. Cancel**:
    - **During the Break**: Any appointment scheduled *during* the break time is **Cancelled** (and marked as "Cancelled by Break").
    - **After the Break**: Appointments scheduled *after* the break are **Shifted** forward by the break duration (e.g., pushed by 15 mins).
2.  **Ghost Appointments**: The system creates invisible "Dummy" appointments to fill the break time in the database. This prevents new online bookings from sneaking into the break slot.

### C. Extensions (Working Overtime)
- **Scenario**: A doctor decides to work past 1:00 PM to finish the queue.
- **Logic**: The Nurse clicks "Extend Session".
- **Validation**: The system checks if extending this session overlaps with the *next* session (e.g., extending Morning past 2:00 PM when Evening starts at 2:00 PM). If valid, the available capacity is instantly increased.

---

## 3. Cancellations & No-Shows

### A. Auto-Status Updates
A background service monitors all appointments:
1.  **Pending -> Skipped**: If an appointment is 15 minutes past its time and the patient hasn't arrived.
2.  **Skipped -> No-Show**: If another 15 minutes pass without activity.

### B. "Rebalancing"
When a patient is marked "No-Show" or "Cancelled", their slot becomes an **Empty Gap**.
- The **Scheduler** instantly detects this gap.
- The next Walk-in patient is "bubbled up" to fill this gap, ensuring zero idle time for the doctor.
