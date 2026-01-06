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
            const updateTimeStr = (str: string) => {
                if (!str) return str;
                try {
                    const date = parse(str, 'hh:mm a', new Date());
                    return format(addHours(date, 3), 'hh:mm a');
                } catch (e) {
                    console.warn(`Could not parse time string: ${str}`);
                    return str;
                }
            };

            if (appt.time) appt.time = updateTimeStr(appt.time);
            if (appt.arriveByTime) appt.arriveByTime = updateTimeStr(appt.arriveByTime);

            if (appt.cutOffTime && typeof appt.cutOffTime.seconds === 'number') {
                appt.cutOffTime.seconds += 10800; // 3 hours
            }
            if (appt.noShowTime && typeof appt.noShowTime.seconds === 'number') {
                appt.noShowTime.seconds += 10800; // 3 hours
            }

            return appt;
        });

        fs.writeFileSync(filePath, JSON.stringify(updatedAppointments, null, 2));
        console.log('Successfully updated appointments.json with +3 hours');
    } catch (error) {
        console.error('Error updating JSON:', error);
    }
}

updateJson();
