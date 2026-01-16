# Executive Summary: Kloqo Application Logic

## Overview
Kloqo is a multi-faceted healthcare management platform designed to streamline the interaction between **Patients**, **Nurses**, and **Clinics**. The system relies on a centralized "Shared Core" of business logic to ensure that data remains consistent across all three applications.

This report outlines the **Business Logic and Algorithms** used to power the ecosystem, specifically focusing on:
1.  **The Patient App**: How patients book slots and receive tokens.
2.  **The Nurse/Clinic App**: How queues are managed on the ground.
3.  **Core Algorithms**: The intelligent scheduling engine that handles conflicts and shifts.

## Key Terminology
*   **Token (e.g., W005, A005)**: A unique identifier for a patient's visit. 'W' stands for Walk-in, 'A' for Appointment.
*   **Session**: A block of time (e.g., Morning Session 9:00 AM - 1:00 PM) where a doctor is available.
*   **Slot Index**: A mathematical representation of time. Instead of "9:15 AM", the system sees "Slot #5". This allows for easier shifting and calculation.
*   **Buffer Queue**: A special "On Deck" list for patients who have physically arrived at the clinic.

## System Architecture (High Level)
*   **Single Source of Truth**: All booking rules (Walk-in logic, Appointment logic) live in one central "Brain". If a Nurse books a patient or a Patient books themselves, they go through the exact same set of checks.
*   **Real-Time Synchronization**: The system uses a "Listener" model. If a Nurse marks a patient as "Completed", the Patient's app updates instantly to show the queue has moved.
