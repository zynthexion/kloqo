export type TimeSlot = {
    from: string;
    to: string;
};

export type AvailabilitySlot = {
    day: string;
    timeSlots: TimeSlot[];
};

// LeaveSlot removed

export type BreakPeriod = {
    id: string;  // unique identifier, e.g., "break-1733289600000"
    startTime: string;  // ISO timestamp
    endTime: string;    // ISO timestamp
    startTimeFormatted: string;  // "09:15 AM"
    endTimeFormatted: string;    // "09:30 AM"
    duration: number;    // minutes
    sessionIndex: number;
    slots: string[];  // array of ISO slot timestamps in this break
};

export type Review = {
    id: string;
    appointmentId: string;
    doctorId: string;
    doctorName: string;
    patientId: string;
    patientName: string;
    rating: number;
    feedback: string;
    createdAt: any;
    clinicId: string;
};

export type Doctor = {
    id: string;
    clinicId: string;
    name: string;
    specialty: string;
    avatar: string;
    schedule: string;
    preferences: string;
    historicalData: string;
    department: string;
    totalPatients?: number;
    todaysAppointments?: number;
    availability: 'Available' | 'Unavailable';
    consultationStatus?: 'In' | 'Out';
    bio?: string;
    averageConsultingTime?: number;
    availabilitySlots?: AvailabilitySlot[];
    // leaveSlots removed
    degrees?: string[];
    experience?: number;
    rating?: number;
    reviews?: number;
    consultationFee?: number;
    freeFollowUpDays?: number;
    advanceBookingDays?: number;
    registrationNumber?: string;
    actualAverageConsultationTime?: number;
    actualAverageConsultationTimeUpdatedAt?: any;
    reviewList?: Review[];
    breakPeriods?: {
        [date: string]: BreakPeriod[];  // multiple breaks per date
    };
    availabilityExtensions?: {
        [date: string]: {
            sessions: Array<{
                sessionIndex: number;
                breaks: BreakPeriod[];  // all breaks in this session
                totalExtendedBy: number;  // sum of all break durations
                originalEndTime: string;  // "05:00 PM"
                newEndTime: string;  // "06:00 PM"
            }>;
        }
    };
};

export type Appointment = {
    id: string;
    clinicId: string;
    patientId: string;
    doctorId?: string;
    patientName: string;
    sex: 'Male' | 'Female' | 'Other';
    communicationPhone: string;
    age: number;
    doctor: string;
    date: string;
    time: string;
    arriveByTime?: string;
    department: string;
    status: 'Confirmed' | 'Pending' | 'Cancelled' | 'Completed' | 'No-show' | 'Skipped';
    treatment?: string; // Optional - not collected from users, kept for backward compatibility
    tokenNumber: string;
    numericToken: number;
    bookedVia: 'Advanced Booking' | 'Walk-in' | 'Online';
    place?: string;
    isSkipped?: boolean;
    slotIndex?: number;
    sessionIndex?: number;
    createdAt?: any;
    completedAt?: any;
    reviewed?: boolean;
    reviewId?: string;
    skippedAt?: any; // Timestamp when appointment was marked as Skipped
    lateMinutes?: number; // Late minutes for skipped appointments
    cutOffTime?: any; // Cut-off time (appointment time - 15 minutes) - when Pending becomes Skipped (ORIGINAL, never delayed)
    noShowTime?: any; // No-show time (appointment time + 15 minutes) - when Skipped becomes No-show (ORIGINAL, never delayed)
    delay?: number; // Delay in minutes added when W tokens are inserted before this appointment
    doctorDelayMinutes?: number; // Delay in minutes due to doctor not starting on time (for display only, doesn't affect status transitions)
    cancellationReason?: string;
    isForceBooked?: boolean; // True if walk-in was force booked outside normal availability
    cancelledByBreak?: boolean; // True if appointment was effectively cancelled due to a break insertion (shifted to a new slot)
    isRescheduled?: boolean; // True if appointment was cancelled due to a reschedule or is the result of a reschedule
    isInBuffer?: boolean;
    bufferedAt?: any;
    isPriority?: boolean;
    priorityAt?: any;
    confirmedAt?: any;
    updatedAt?: any;
};

export type Patient = {
    id: string;
    primaryUserId?: string;
    clinicIds?: string[];
    name: string;
    age: number;
    sex: 'Male' | 'Female' | 'Other' | '';
    phone: string;
    communicationPhone?: string;
    email?: string;
    place?: string;
    totalAppointments: number;
    visitHistory?: string[]; // Array of appointment IDs
    createdAt: any;
    updatedAt: any;
    relatedPatientIds?: string[];
    isPrimary?: boolean;
    isKloqoMember?: boolean;
};

export type NewRelative = Omit<Patient, 'id' | 'clinicIds' | 'visitHistory' | 'totalAppointments' | 'createdAt' | 'updatedAt' | 'relatedPatientIds'> & { phone?: string };

export type Clinic = {
    id: string;
    name: string;
    type?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    logo?: string;
    logoUrl?: string;
    clinicRegNumber?: string;
    tokenDistribution?: 'classic' | 'advanced';
    genderPreference?: 'None' | 'Men' | 'Women';
    [key: string]: any;
};

export type Visit = {
    appointmentId: string;
    clinicId?: string;
    date: string;
    time: string;
    doctor: string;
    department: string;
    treatment?: string; // Optional - not collected from users, kept for backward compatibility
    status: 'Confirmed' | 'Pending' | 'Cancelled' | 'Completed' | 'No-show';
}

export type Activity = {
    id: string;
    timestamp: string;
    description: string;
    icon: any; // React.ComponentType<{ className?: string }>; - using any to avoid React dependency in types package for now
};

export type Report = {
    id: string;
    name: string;
    statuses: string[];
    type: 'room' | 'equipment';
};

export type Department = {
    id: string;
    name: string;
    description: string;
    icon: string;
    doctors: string[];
}

export type LiveStatus = {
    id: string;
    doctorName: string;
    specialty: string;
    room: string;
    status: 'available' | 'break';
    currentToken?: string;
    queue?: number;
    returnTime?: string;
};

export type MobileApp = {
    id: string;
    clinicId: string;
    username: string;
    password?: string;
}

export type User = {
    uid: string;
    phone: string;
    role?: 'clinicAdmin' | 'patient';
    patientId?: string;
    clinicId?: string;
    email?: string;
    name?: string;
    designation?: 'Doctor' | 'Owner';
    onboarded?: boolean;
    pwaInstalled?: boolean;
}
