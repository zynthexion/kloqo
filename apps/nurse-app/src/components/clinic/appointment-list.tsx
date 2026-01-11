
'use client';

import { useState, useEffect, useRef, useMemo, memo } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';
import type { Appointment } from '@/lib/types';
import { parse, subMinutes, format } from 'date-fns';
import { cn, getDisplayTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { User, XCircle, Edit, Check, CheckCircle2, SkipForward, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useRouter } from 'next/navigation';


const SWIPE_COOLDOWN_MS = 2 * 60 * 1000;

type SwipeState = { id: string | null; startX: number; currentX: number; width: number };
const createSwipeState = (): SwipeState => ({ id: null, startX: 0, currentX: 0, width: 0 });

type AppointmentListProps = {
  appointments: Appointment[];
  onUpdateStatus?: (id: string, status: 'completed' | 'Cancelled' | 'No-show' | 'Skipped') => void;
  onRejoinQueue?: (appointment: Appointment) => void;
  onAddToQueue?: (appointment: Appointment) => void | ((appointment: Appointment) => void);
  showTopRightActions?: boolean;
  clinicStatus?: 'In' | 'Out';
  currentTime?: Date;
  isInBufferQueue?: (appointment: Appointment) => boolean;
  enableSwipeCompletion?: boolean;
  showStatusBadge?: boolean;
  isPhoneMode?: boolean;
};

// Helper function to parse time
function parseTime(timeStr: string, referenceDate: Date): Date {
  try {
    return parse(timeStr, 'hh:mm a', referenceDate);
  } catch {
    // Fallback to 24h format
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date(referenceDate);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }
}

function AppointmentList({ appointments, onUpdateStatus, onRejoinQueue, onAddToQueue, showTopRightActions = true, clinicStatus = 'In', currentTime = new Date(), isInBufferQueue, enableSwipeCompletion = true, showStatusBadge = true, isPhoneMode = false }: AppointmentListProps) {
  const router = useRouter();
  const [pendingCompletionId, setPendingCompletionId] = useState<string | null>(null);
  const [swipeCooldownUntil, setSwipeCooldownUntil] = useState<number | null>(null);

  // Check if Confirm Arrival button should be shown (show for all pending appointments)
  const shouldShowConfirmArrival = (appointment: Appointment): boolean => {
    // Show confirm arrival icon for all pending appointments
    return appointment.status === 'Pending';
  };
  const [swipeState, setSwipeState] = useState<SwipeState>(createSwipeState);
  const swipeDataRef = useRef<SwipeState>(createSwipeState());
  const swipedItemRef = useRef<HTMLDivElement | null>(null);

  const getIcon = (type: Appointment['bookedVia']) => {
    switch (type) {
      case 'Advanced Booking':
        return <User className="text-blue-500" />;
      case 'Walk-in':
        return <User className="text-green-500" />;
      default:
        return <User className="text-gray-500" />;
    }
  };

  const getStatusBadge = (appt: Appointment) => {
    switch (appt.status) {
      case 'No-show':
        return <Badge variant="destructive">No-show</Badge>
      case 'Pending':
        return <Badge variant="secondary">Pending</Badge>
      case 'Confirmed':
        return <Badge variant="default">Confirmed</Badge>
      case 'Cancelled':
        if (appt.cancellationReason === 'DOCTOR_LEAVE') {
          return <Badge variant="destructive" className="bg-orange-500 text-white">Doctor Leave</Badge>;
        }
        if (appt.isRescheduled) {
          return (
            <Badge
              variant="outline"
              className="bg-orange-100 text-orange-800 border-orange-200"
            >
              Rescheduled
            </Badge>
          );
        }
        return <Badge variant="secondary">Cancelled</Badge>
      case 'Completed':
        return <Badge variant="default" className="bg-green-600">Completed</Badge>
      case 'Skipped':
        return <Badge variant="destructive" className="bg-yellow-500 text-white">Skipped</Badge>;
      default:
        return null;
    }
  }

  const handleEditClick = (id: string) => {
    router.push(`/appointments/${id}/edit`);
  };

  const isActionable = (appt: Appointment) => appt.status === 'Pending' || appt.status === 'Confirmed' || appt.status === 'Skipped' || appt.status === 'No-show';
  const isInactive = (appt: Appointment) => ['Completed', 'Cancelled'].includes(appt.status);
  const isClinicOut = clinicStatus === 'Out';
  const swipeEnabled = enableSwipeCompletion && !!onUpdateStatus && !isClinicOut;

  const firstActionableAppointmentId = useMemo(() => {
    const actionableAppt = appointments.find(isActionable);
    return actionableAppt ? actionableAppt.id : null;
  }, [appointments]);

  // Swipe Handlers
  const isSwipeOnCooldown = swipeCooldownUntil !== null && swipeEnabled;

  useEffect(() => {
    if (!swipeEnabled || swipeCooldownUntil === null) return;
    const remaining = Math.max(0, swipeCooldownUntil - Date.now());
    const timeout = window.setTimeout(() => {
      setSwipeCooldownUntil(null);
    }, remaining);
    return () => clearTimeout(timeout);
  }, [swipeCooldownUntil, swipeEnabled]);

  type SwipeEvent = ReactMouseEvent<HTMLDivElement> | ReactTouchEvent<HTMLDivElement>;

  const handleSwipeStart = (e: SwipeEvent, id: string) => {
    if (!swipeEnabled || isSwipeOnCooldown) return;

    const targetAppointment = appointments.find(a => a.id === id);
    if (!targetAppointment || !isActionable(targetAppointment)) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const target = e.currentTarget as HTMLElement | null;
    const width = target?.offsetWidth ?? 0;
    const nextState: SwipeState = { id, startX: clientX, currentX: clientX, width };
    swipeDataRef.current = nextState;
    setSwipeState(nextState);
  };

  const handleSwipeMove = (e: SwipeEvent) => {
    if (!swipeEnabled || swipeDataRef.current.id === null) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    swipeDataRef.current = { ...swipeDataRef.current, currentX: clientX };
    setSwipeState({ ...swipeDataRef.current });
  };

  const handleSwipeEnd = () => {
    if (!swipeEnabled || swipeDataRef.current.id === null) return;

    const { id, currentX, startX, width } = swipeDataRef.current;
    const deltaX = currentX - startX;
    const swipeWidth = width || swipedItemRef.current?.offsetWidth || 0;
    const swipeThreshold = swipeWidth * 0.6; // 60% of the card width to confirm

    if (swipeThreshold === 0) {
      const reset = createSwipeState();
      swipeDataRef.current = reset;
      setSwipeState(reset);
      return;
    }

    if (deltaX < -swipeThreshold) { // Swiped left
      setPendingCompletionId(id);
    }

    const reset = createSwipeState();
    swipeDataRef.current = reset;
    setSwipeState(reset);
  };

  const getSwipeStyle = (id: string): React.CSSProperties => {
    if (!swipeEnabled || swipeState.id !== id) return { transition: 'transform 0.2s ease-out, background-color 0.2s ease-out' };

    const deltaX = swipeState.currentX - swipeState.startX;

    // Only allow swiping to the left
    const limitedDeltaX = Math.min(0, deltaX);
    const baseWidth = swipeState.width || swipedItemRef.current?.offsetWidth || 300;
    const opacity = Math.min(Math.abs(limitedDeltaX) / (baseWidth * 0.7 || 1), 0.7);

    return {
      transform: `translateX(${limitedDeltaX}px)`,
      backgroundColor: `rgba(4, 120, 87, ${opacity})`, // bg-green-700 with dynamic opacity
      transition: swipeState.id === null ? 'transform 0.2s ease-out, background-color 0.2s ease-out' : 'none',
    };
  };

  return (
    <>
      <TooltipProvider>
        <div
          className="flex-1"
          onMouseUp={swipeEnabled ? handleSwipeEnd : undefined}
          onMouseLeave={swipeEnabled ? handleSwipeEnd : undefined}
          onTouchEnd={swipeEnabled ? handleSwipeEnd : undefined}
          onMouseMove={swipeEnabled ? handleSwipeMove : undefined}
          onTouchMove={swipeEnabled ? handleSwipeMove : undefined}
        >
          <div className="space-y-3 p-2">
            {swipeEnabled && isSwipeOnCooldown && (
              <div className="text-xs text-amber-600 font-medium px-2">
                Swipe-to-complete is temporarily disabled for 2 minutes after each completion.
              </div>
            )}
            {appointments.length > 0 ? (
              appointments.map((appt, index) => {
                const isSwiping = swipeState.id === appt.id;

                const isBuffer = isInBufferQueue && isInBufferQueue(appt);

                return (
                  <div
                    key={appt.id}
                    ref={swipeState.id === appt.id ? swipedItemRef : null}
                    className={cn(
                      "p-4 flex flex-col gap-3 border rounded-xl transition-all duration-200",
                      isSwiping && 'text-white',
                      !isSwiping && "bg-white border-border shadow-md hover:shadow-lg",
                      !isSwiping && isBuffer && "bg-yellow-50/50 border-yellow-400",
                      !isSwiping && appt.skippedAt && "bg-amber-50/50 border-amber-400",
                    )}
                    style={getSwipeStyle(appt.id)}
                    onMouseDown={swipeEnabled ? (e) => handleSwipeStart(e, appt.id) : undefined}
                    onTouchStart={swipeEnabled ? (e) => handleSwipeStart(e, appt.id) : undefined}
                  >
                    <div
                      className={cn(
                        "transition-opacity duration-200",
                        !isSwiping && appt.status === 'Skipped' && 'border-l-4 border-yellow-400 pl-2',
                        !isSwiping && appt.status === 'Completed' && 'opacity-50',
                        !isSwiping && appt.status === 'Cancelled' && (appt.cancellationReason === 'DOCTOR_LEAVE' ? 'border-l-4 border-orange-400 pl-2' : 'opacity-60'),
                      )}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-4 flex-1">
                          <div className="flex-1">
                            <div className="flex justify-between items-center">
                              <Badge variant={isSwiping ? 'default' : 'outline'} className={cn("text-xs", isSwiping && 'bg-white/20 text-white')}>
                                {appt.date && `${appt.date} - `}
                                {['Confirmed', 'Completed', 'Cancelled', 'No-show'].includes(appt.status) ? appt.time : getDisplayTime(appt)}
                              </Badge>
                              {showStatusBadge && getStatusBadge(appt)}
                              {onUpdateStatus && isActionable(appt) && !showTopRightActions && (
                                <div className="flex items-center gap-2">
                                  {appt.status === 'Pending' && onAddToQueue && shouldShowConfirmArrival(appt) && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="outline"
                                          size="icon"
                                          className="h-7 w-7 bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                                          onClick={() => onAddToQueue(appt)}
                                        >
                                          <CheckCircle2 className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>Confirm Arrival</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  {appt.id === firstActionableAppointmentId && appt.status === 'Confirmed' && onUpdateStatus && !showTopRightActions && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="outline"
                                          size="icon"
                                          className="h-7 w-7 bg-yellow-50 hover:bg-yellow-100 text-yellow-700 border-yellow-200"
                                          onClick={() => onUpdateStatus(appt.id, 'Skipped')}
                                          disabled={isClinicOut}
                                        >
                                          <SkipForward className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>Skip Appointment</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  {(appt.status === 'Skipped' || appt.status === 'No-show') && onRejoinQueue ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 px-2 bg-green-50 hover:bg-green-100 text-green-700 border-green-200"
                                      onClick={() => onRejoinQueue(appt)}
                                    >
                                      <Check className="mr-1 h-3 w-3" /> Rejoin
                                    </Button>
                                  ) : null}
                                </div>
                              )}
                            </div>
                            <div className="flex justify-between items-start mt-1">
                              <div className="flex items-center gap-2">
                                <div className="flex items-center gap-2">
                                  <p className={cn("font-semibold", isInactive(appt) && 'line-through text-muted-foreground')}>
                                    {['Completed', 'Cancelled', 'No-show'].includes(appt.status) ? appt.patientName : `#${appt.tokenNumber} - ${appt.patientName}`}
                                  </p>
                                  {appt.skippedAt && (
                                    <Badge variant="outline" className="text-[10px] h-4 px-1 bg-amber-200 border-amber-400 text-amber-800 leading-none flex items-center justify-center font-bold">
                                      Late
                                    </Badge>
                                  )}
                                </div>
                              </div>

                              {isPhoneMode && (
                                <div className="mt-2 text-white">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 gap-2 bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (appt.communicationPhone) {
                                        window.location.href = `tel:${appt.communicationPhone}`;
                                      }
                                    }}
                                  >
                                    <Phone className="h-3 w-3" />
                                    <span>{appt.communicationPhone || 'No Number'}</span>
                                  </Button>
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {(appt.age && appt.place) && (
                                <p className={cn("text-sm", isSwiping ? 'text-white/80' : 'text-muted-foreground')}>
                                  {appt.age} yrs, {appt.place}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>

                        {showTopRightActions && isActionable(appt) && (
                          <div className="flex items-center gap-1 -mr-2">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button size="icon" variant="ghost" className="h-8 w-8 text-blue-500 hover:text-blue-600" onClick={() => handleEditClick(appt.id)} disabled={isClinicOut}>
                                  <Edit className="h-5 w-5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Edit Appointment</p>
                              </TooltipContent>
                            </Tooltip>
                            {onUpdateStatus && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={isClinicOut}>
                                        <XCircle className="h-5 w-5" />
                                      </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>Cancel Appointment?</AlertDialogTitle>
                                        <AlertDialogDescription>
                                          Are you sure you want to cancel this appointment for {appt.patientName}? This action cannot be undone.
                                        </AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Go Back</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => onUpdateStatus(appt.id, 'Cancelled')} className="bg-destructive hover:bg-destructive/90">
                                          Confirm Cancel
                                        </AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Cancel Appointment</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="h-24 flex items-center justify-center text-center text-muted-foreground">
                <p>No appointments found for the selected criteria.</p>
              </div>
            )}
          </div>
        </div>
      </TooltipProvider>
      {swipeEnabled && (
        <AlertDialog open={!!pendingCompletionId} onOpenChange={(open) => !open && setPendingCompletionId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Mark appointment complete?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingCompletionId ? `This will mark ${appointments.find(a => a.id === pendingCompletionId)?.patientName ?? 'the patient'} as completed.` : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-green-600 hover:bg-green-700"
                onClick={() => {
                  if (!pendingCompletionId || !onUpdateStatus) return;
                  onUpdateStatus(pendingCompletionId, 'completed');
                  setPendingCompletionId(null);
                  setSwipeCooldownUntil(Date.now() + SWIPE_COOLDOWN_MS);
                }}
              >
                Confirm Complete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

// Memoize the component to prevent unnecessary re-renders
export default memo(AppointmentList);
