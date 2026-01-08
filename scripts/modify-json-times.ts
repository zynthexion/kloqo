import * as fs from 'fs';
import * as path from 'path';
import { parse, format, addHours } from 'date-fns';

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
                // Parse the appointment time and date
                const apptDateTime = parse(`${appt.date} ${appt.time}`, 'd MMMM yyyy hh:mm a', new Date());
                const baseSeconds = Math.floor(apptDateTime.getTime() / 1000);

                // noShowTime = time + 15 minutes
                if (appt.noShowTime) {
                    appt.noShowTime.seconds = baseSeconds + (15 * 60);
                    appt.noShowTime.nanoseconds = 0;
                }

                // cutOffTime = time - 15 minutes
                if (appt.cutOffTime) {
                    appt.cutOffTime.seconds = baseSeconds - (15 * 60);
                    appt.cutOffTime.nanoseconds = 0;
                }

                console.log(`Updated ${appt.patientName} (${appt.time}): cutOff -15m, noShow +15m`);
            } catch (e) {
                console.warn(`Error processing appointment ${appt.id}:`, e);
            }

            return appt;
        });

        fs.writeFileSync(filePath, JSON.stringify(updatedAppointments, null, 2));
        console.log('Successfully updated appointments.json: Aligned noShowTime and cutOffTime');
    } catch (error) {
        console.error('Error updating JSON:', error);
    }
}

updateJson();
