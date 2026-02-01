# Twilio Content Templates for WhatsApp Notifications

This document outlines the required Twilio Content Templates for the WhatsApp notification system. Staff should register these templates in the Twilio Console to enable automated notifications.

## Templates

### 1. Appointment Confirmed (Advanced Booking / A Token)

**Template Name:** `kloqo_appointment_confirmed`
**Language:** English (en)
**Content Type:** Text

#### Body
> Hello {{1}}, your appointment with Dr. {{2}} at {{3}} is confirmed. Please arrive by {{6}} on {{4}}. Token: {{7}}. View live status: {{8}}

#### Variables
1. **Patient Name**: (e.g., John Doe)
2. **Doctor Name**: (e.g., Smith)
3. **Clinic Name**: (e.g., City Clinic)
4. **Date**: (e.g., 25 January 2024)
5. **Time**: (e.g., 10:30 AM)
6. **Arrive By Time**: (e.g., 10:15 AM)
7. **Token Number**: (e.g., A-101)
8. **Live Status Link**: (e.g., https://app.kloqo.com/live-token/APT123)

---

## Technical Implementation Notes

Templates are sent via the Twilio Content API using:
- **Content SID**: A unique identifier starting with `HXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`.
- **Content Variables**: A JSON object mapping indices `"1"`, `"2"`, etc., to their respective values.

> [!IMPORTANT]
> Ensure that the Twilio WhatsApp number is correctly configured and that the recipients have opted in as per Twilio's requirements for the initial message.
