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
                const baseDate = new Date();
                const ADD_MINUTES = 60;
                const ADD_SECONDS = ADD_MINUTES * 60;

                // 1. Add 180m (3h) to 'time'
                const apptTime = parse(appt.time, 'hh:mm a', baseDate);
                const newApptTime = addMinutes(apptTime, ADD_MINUTES);
                appt.time = format(newApptTime, 'hh:mm a');

                // 2. Add 180m (3h) to 'arriveByTime'
                if (appt.arriveByTime) {
                    const arriveTime = parse(appt.arriveByTime, 'hh:mm a', baseDate);
                    const newArriveTime = addMinutes(arriveTime, ADD_MINUTES);
                    appt.arriveByTime = format(newArriveTime, 'hh:mm a');
                }

                // 3. Add 180m (10800s) to Firestore Timestamps
                if (appt.noShowTime && typeof appt.noShowTime.seconds === 'number') {
                    appt.noShowTime.seconds += ADD_SECONDS;
                }

                if (appt.cutOffTime && typeof appt.cutOffTime.seconds === 'number') {
                    appt.cutOffTime.seconds += ADD_SECONDS;
                }

                console.log(`Updated ${appt.patientName}: ${appt.time} (Shifted +3h)`);
            } catch (e) {
                console.warn(`Error processing appointment ${appt.id}:`, e);
            }

            return appt;
        });

        fs.writeFileSync(filePath, JSON.stringify(updatedAppointments, null, 2));
        console.log('Successfully updated appointments.json: Added 3 hours to all fields');
    } catch (error) {
        console.error('Error updating JSON:', error);
    }
}

updateJson();
