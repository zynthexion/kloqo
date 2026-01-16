# Core Algorithms: The "Scheduler"

The Scheduler is the brain of Kloqo. It determines exactly who gets seen when. It runs every time a new booking is requested.

## 1. The "Tetris" Logic (Slot Management)

### A. The Grid
Imagine the day as a grid of 15-minute blocks (Slots).
- **Index 0**: 9:00 AM
- **Index 1**: 9:15 AM
- **Index 2**: 9:30 AM ...

### B. Allocation Strategy
When a new Walk-in comes:
1.  **Scan for Holes**: Is `Index 5` empty? (Maybe `A-005` cancelled). If yes, grab it.
2.  **Look Later**: If `Index 5` is full, check `Index 6`.
3.  **Spacing Check**: To prevent "Walk-in Overload", the system tries to keep a gap. It might skip `Index 6` if `Index 7` is a better fit for flow.

## 2. The "Shifting" Engine
What happens if a VIP patient needs to be force-booked at 10:00 AM, but 10:00 AM is full?

1.  **Identify the Block**: The system finds the patient currently at 10:00 AM.
2.  **Chain Reaction**:
    - Patient A (10:00) is moved to 10:15.
    - Patient B (10:15) is moved to 10:30.
    - Patient C (10:30) is moved to 10:45.
3.  **Stop Condition**: The shifting stops once it finds an empty slot (a "Gap") to absorb the displacement.
4.  **Virtual Slots**: If the day is completely full, the system creates "Virtual Slots" (Index 100+) at the end of the day to hold the overflow patients.

## 3. Conflict Resolution
With three apps hitting the database at once, conflicts are possible.

**Mechanism**: `Firestore Transactions`
- **Atomic Operations**: When you book a slot, the system "Locks" the database counter.
- **The Race**: If Patient A and Nurse B try to book Slot #5 at the same time:
    - The first request wins.
    - The second request "fails" instantly, re-reads the data, sees Slot #5 is gone, and automatically retries for Slot #6.
- **Zero Double Bookings**: This guarantees that two patients never hold the same token number.
