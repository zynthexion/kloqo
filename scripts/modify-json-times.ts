import * as fs from 'fs';
import * as path from 'path';
import { parse, format, addMinutes } from 'date-fns';

async function updateJson() {
    try {
        const filePath = path.resolve(process.cwd(), 'appointments.json');
        if (!fs.existsSync(filePath)) {
            console.error('appointments.json not found');
            return;
        }

        const rawData = fs.readFileSync(filePath, 'utf-8');
        const appointments = JSON.parse(rawData);

        const updatedAppointments = appointments.map((appt: any) => {
            if (!appt.time || !appt.date) return appt;

            try {
                const ADD_HOURS = 16;
                const ADD_MINUTES = ADD_HOURS * 60;
                const ADD_SECONDS = ADD_MINUTES * 60;

                // Combine date and time to handle date rollover correctly
                // Date format: "14 January 2026", Time format: "10:00 PM"
                const combinedStr = `${appt.date} ${appt.time}`;
                const apptDateTime = parse(combinedStr, 'd MMMM yyyy hh:mm a', new Date());

                const newApptDateTime = addMinutes(apptDateTime, ADD_MINUTES);

                // Update time and date
                appt.time = format(newApptDateTime, 'hh:mm a');
                appt.date = format(newApptDateTime, 'd MMMM yyyy');

                // 2. Update 'arriveByTime'
                if (appt.arriveByTime) {
                    const arriveCombinedStr = `${format(apptDateTime, 'd MMMM yyyy')} ${appt.arriveByTime}`;
                    const arriveDateTime = parse(arriveCombinedStr, 'd MMMM yyyy hh:mm a', new Date());
                    const newArriveDateTime = addMinutes(arriveDateTime, ADD_MINUTES);
                    appt.arriveByTime = format(newArriveDateTime, 'hh:mm a');
                }

                // 3. Add seconds to Firestore Timestamps
                if (appt.noShowTime && typeof appt.noShowTime.seconds === 'number') {
                    appt.noShowTime.seconds += ADD_SECONDS;
                }

                if (appt.cutOffTime && typeof appt.cutOffTime.seconds === 'number') {
                    appt.cutOffTime.seconds += ADD_SECONDS;
                }

                console.log(`Updated ${appt.patientName}: ${appt.date} ${appt.time} (Shifted +16h)`);
            } catch (e) {
                console.warn(`Error processing appointment ${appt.id}:`, e);
            }

            return appt;
        });

        fs.writeFileSync(filePath, JSON.stringify(updatedAppointments, null, 2));
        console.log('Successfully updated appointments.json: Added 16 hours to all fields across dates');
    } catch (error) {
        console.error('Error updating JSON:', error);
    }
}

updateJson();
