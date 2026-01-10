import * as fs from 'fs';
import * as path from 'path';
import { parse, format, subMinutes } from 'date-fns';

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
                const SUBTRACT_MINUTES = 45;
                const SUBTRACT_SECONDS = SUBTRACT_MINUTES * 60;

                // 1. Subtract 45m from 'time'
                const apptTime = parse(appt.time, 'hh:mm a', baseDate);
                const newApptTime = subMinutes(apptTime, SUBTRACT_MINUTES);
                appt.time = format(newApptTime, 'hh:mm a');

                // 2. Subtract 45m from 'arriveByTime'
                if (appt.arriveByTime) {
                    const arriveTime = parse(appt.arriveByTime, 'hh:mm a', baseDate);
                    const newArriveTime = subMinutes(arriveTime, SUBTRACT_MINUTES);
                    appt.arriveByTime = format(newArriveTime, 'hh:mm a');
                }

                // 3. Subtract 45m (2700s) from Firestore Timestamps
                if (appt.noShowTime && typeof appt.noShowTime.seconds === 'number') {
                    appt.noShowTime.seconds -= SUBTRACT_SECONDS;
                }

                if (appt.cutOffTime && typeof appt.cutOffTime.seconds === 'number') {
                    appt.cutOffTime.seconds -= SUBTRACT_SECONDS;
                }

                console.log(`Updated ${appt.patientName}: ${appt.time} (Shifted -45m)`);
            } catch (e) {
                console.warn(`Error processing appointment ${appt.id}:`, e);
            }

            return appt;
        });

        fs.writeFileSync(filePath, JSON.stringify(updatedAppointments, null, 2));
        console.log('Successfully updated appointments.json: Subtracted 45 minutes from all fields');
    } catch (error) {
        console.error('Error updating JSON:', error);
    }
}

updateJson();
