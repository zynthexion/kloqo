
'use client';

import { useState, useEffect, useRef, useMemo, memo } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';
import type { Appointment } from '@/lib/types';
import { parse, subMinutes, format, addMinutes, isAfter } from 'date-fns';
import { cn, getDisplayTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { User, XCircle, Edit, Check, CheckCircle2, SkipForward, Phone, Star } from 'lucide-react';
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


const SWIPE_COOLDOWN_MS = 30 * 1000;

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
  showPositionNumber?: boolean;
  showEstimatedTime?: boolean;
  averageConsultingTime?: number;
  estimatedTimes?: Array<{ appointmentId: string; estimatedTime: string; isFirst: boolean }>;
  breaks?: Array<{ id: string; startTime: string; endTime: string; note?: string }>;
  onTogglePriority?: (appointment: Appointment) => void;
  tokenDistribution?: 'classic' | 'advanced';
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

function AppointmentList({
  appointments,
  onUpdateStatus,
  onRejoinQueue,
  onAddToQueue,
  showTopRightActions = true,
  clinicStatus = 'In',
  currentTime = new Date(),
  isInBufferQueue,
  enableSwipeCompletion = true,
  showStatusBadge = true,
  isPhoneMode = false,
  showPositionNumber = false,
  showEstimatedTime = false,
  averageConsultingTime = 15,
  estimatedTimes = [],
  breaks = [],
  onTogglePriority,
  tokenDistribution = 'advanced'
}: AppointmentListProps) {
  const router = useRouter();
  const [pendingCompletionId, setPendingCompletionId] = useState<string | null>(null);
  const [swipeCooldownUntil, setSwipeCooldownUntil] = useState<number | null>(null);

  // Check if Confirm Arrival button should be shown (show for pending, skipped, no-show)
  const shouldShowConfirmArrival = (appointment: Appointment): boolean => {
    return ['Pending', 'Skipped', 'No-show'].includes(appointment.status);
  };
  const [swipeState, setSwipeState] = useState<SwipeState>(createSwipeState);
  const swipeDataRef = useRef<SwipeState>(createSwipeState());
  // Long press for Skip & Priority
  const swipedItemRef = useRef<HTMLDivElement | null>(null);
  const [showSkipConfirm, setShowSkipConfirm] = useState<string | null>(null);
  const [pressState, setPressState] = useState<{ id: string | null; type: 'skip' | 'priority' | null; progress: number }>({ id: null, type: null, progress: 0 });
  const pressStartTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);
  const startPosRef = useRef<{ x: number, y: number } | null>(null);

  const handlePressStart = (e: React.MouseEvent | React.TouchEvent, id: string) => {
    e.stopPropagation();
    // Prevent default to avoid text selection or other default behaviors
    if (e.type === 'touchstart') e.preventDefault();
    if (swipeState.id) return; // Don't start if swiping

    setPressState({ id, type: 'skip', progress: 0 });
    pressStartTimeRef.current = Date.now();

    // Animate progress bar
    const animate = () => {
      const elapsed = Date.now() - pressStartTimeRef.current;
      const progress = Math.min((elapsed / 3000) * 100, 100); // 3 seconds for skip

      setPressState(prev => ({ ...prev, progress }));

      if (progress < 100) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Completed
        setShowSkipConfirm(id);
        setPressState({ id: null, type: null, progress: 0 });
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);
  };

  const handlePressEnd = (e?: React.MouseEvent | React.TouchEvent) => {
    if (e) {
      e.stopPropagation();
      // Only prevent default if it's a touch event to avoid blocking clicks
      if (e.type === 'touchend' && pressState.progress > 0) {
        // e.preventDefault(); // Don't prevent default here as it might block the actual end of touch
      }
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    setPressState({ id: null, type: null, progress: 0 });
  };

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const handleCardTouchStart = (e: React.TouchEvent | React.MouseEvent, appt: Appointment) => {
    // If we are already handling a button press or swipe, ignore
    if (pressState.id || swipeState.id) return;

    if (swipeEnabled) handleSwipeStart(e as any, appt.id);

    // Only allow priority for Pending/Confirmed
    if (appt.status !== 'Pending' && appt.status !== 'Confirmed') return;
    if (appt.isPriority) return; // Already priority

    const touch = 'touches' in e ? (e as React.TouchEvent).touches[0] : (e as React.MouseEvent);
    startPosRef.current = { x: touch.clientX, y: touch.clientY };
    pressStartTimeRef.current = Date.now();

    // Start Priority Press
    setPressState({ id: appt.id, type: 'priority', progress: 0 });

    const animate = () => {
      const elapsed = Date.now() - pressStartTimeRef.current;
      const progress = Math.min((elapsed / 800) * 100, 100); // 800ms for priority

      setPressState(prev => ({ ...prev, progress }));

      if (progress < 100) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Completed
        if (onTogglePriority) onTogglePriority(appt);
        setPressState({ id: null, type: null, progress: 0 });
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);
  };

  const handleCardTouchMove = (e: React.TouchEvent | React.MouseEvent) => {
    if (swipeEnabled) handleSwipeMove(e as any);

    // Check if moved too much for long press
    if (pressState.type === 'priority' && startPosRef.current) {
      const touch = 'touches' in e ? (e as React.TouchEvent).touches[0] : (e as React.MouseEvent);
      const dx = Math.abs(touch.clientX - startPosRef.current.x);
      const dy = Math.abs(touch.clientY - startPosRef.current.y);

      if (dx > 10 || dy > 10) { // Moved more than 10px
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        setPressState({ id: null, type: null, progress: 0 });
        startPosRef.current = null;
      }
    }
  };

  const handleCardTouchEnd = (e: React.TouchEvent | React.MouseEvent) => {
    if (swipeEnabled) handleSwipeEnd();

    if (pressState.type === 'priority') {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      setPressState({ id: null, type: null, progress: 0 });
    }
    startPosRef.current = null;
  };
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // Merge appointments and breaks for rendering
  const mixedItems = useMemo(() => {
    // If no breaks, return mapped appointments
    // But we need consistent shape.
    let items: Array<{ type: 'appointment' | 'break' | 'session-header'; data: any }> = [];

    // Sort breaks by start time and filter out past breaks
    const sortedBreaks = [...breaks]
      .filter(b => isAfter(new Date(b.endTime), currentTime))
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

    // Helper to get appointment time (estimated or computed)
    const getApptTime = (apt: Appointment) => {
      const est = estimatedTimes.find(e => e.appointmentId === apt.id);
      if (est) {
        return parseTime(est.estimatedTime, new Date());
      }
      return new Date(8640000000000000); // Push to end if no time
    };

    let breakIndex = 0;
    let lastSessionIndex = -1;

    appointments.forEach(apt => {
      const aptTime = getApptTime(apt);
      const currentSessionIndex = apt.sessionIndex ?? 0;

      // Insert any breaks that start before this appointment
      while (breakIndex < sortedBreaks.length) {
        const brk = sortedBreaks[breakIndex];
        const brkStart = new Date(brk.startTime);

        if (brkStart.getTime() <= aptTime.getTime()) {
          items.push({ type: 'break', data: brk });
          breakIndex++;
        } else {
          break;
        }
      }

      // Insert session header if session changed
      if (currentSessionIndex !== lastSessionIndex) {
        items.push({ type: 'session-header', data: { sessionIndex: currentSessionIndex } });
        lastSessionIndex = currentSessionIndex;
      }

      items.push({ type: 'appointment', data: apt });
    });

    // Add remaining breaks
    while (breakIndex < sortedBreaks.length) {
      items.push({ type: 'break', data: sortedBreaks[breakIndex] });
      breakIndex++;
    }

    // If both empty
    if (items.length === 0 && appointments.length === 0 && breaks.length === 0) return [];

    return items;
  }, [appointments, breaks, estimatedTimes]);

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
                Swipe-to-complete is temporarily disabled for 30 seconds after each completion.
              </div>
            )}

            {(() => {
              let appointmentCounter = 0;
              return mixedItems.length > 0 ? (
                mixedItems.map((item, index) => {
                  // RENDER BREAK
                  if (item.type === 'break') {
                    const brk = item.data;
                    const now = currentTime.getTime();
                    const breakStart = new Date(brk.startTime).getTime();
                    const breakEnd = new Date(brk.endTime).getTime();
                    const isBreakActive = now >= breakStart && now < breakEnd;

                    if (clinicStatus === 'In' && isBreakActive) {
                      return null;
                    }

                    const startLabel = format(new Date(brk.startTime), 'h:mm a');
                    const endLabel = format(new Date(brk.endTime), 'h:mm a');
                    return (
                      <div key={`break-${index}`} className="flex items-center justify-center p-3 bg-amber-50 rounded-lg border border-amber-100 text-amber-800 text-sm font-medium">
                        <span className="flex items-center gap-2">
                          <span className="block w-2 h-2 rounded-full bg-amber-500" />
                          Break: {startLabel} - {endLabel} {brk.note ? `(${brk.note})` : ''}
                        </span>
                      </div>
                    );
                  }

                  // RENDER SESSION HEADER
                  if (item.type === 'session-header') {
                    const sessionIdx = item.data.sessionIndex;
                    return (
                      <div key={`session-${sessionIdx}-${index}`} className="flex items-center gap-3 py-2 px-1">
                        <div className="flex-1 h-px bg-slate-200" />
                        <Badge variant="outline" className="bg-slate-100 text-slate-600 border-slate-200 font-bold uppercase tracking-wider text-[10px] px-2 py-0.5">
                          Session {sessionIdx + 1}
                        </Badge>
                        <div className="flex-1 h-px bg-slate-200" />
                      </div>
                    );
                  }

                  // RENDER APPOINTMENT
                  appointmentCounter++;
                  const appt = item.data as Appointment;
                  const currentPos = appointmentCounter;
                  const isSwiping = swipeState.id === appt.id;
                  const isBuffer = isInBufferQueue && isInBufferQueue(appt);

                  return (
                    <div
                      key={appt.id}
                      ref={swipeState.id === appt.id ? swipedItemRef : null}
                      className={cn(
                        "p-4 flex flex-col gap-3 border rounded-xl transition-all duration-200 relative",
                        isSwiping && 'text-white',
                        !isSwiping && "bg-white border-border shadow-md hover:shadow-lg",
                        !isSwiping && appt.status === 'Confirmed' && !appt.isPriority && "bg-green-50 border-green-200",
                        !isSwiping && appt.isPriority && "bg-amber-50 border-amber-400 shadow-md ring-1 ring-amber-400/50",
                        !isSwiping && isBuffer && !appt.isPriority && "bg-blue-50/80 border-blue-400",
                        !isSwiping && appt.skippedAt && "bg-amber-50/50 border-amber-400",
                      )}
                      style={getSwipeStyle(appt.id)}
                      onMouseDown={(e) => handleCardTouchStart(e, appt)}
                      onTouchStart={(e) => handleCardTouchStart(e, appt)}
                      onMouseMove={handleCardTouchMove}
                      onTouchMove={handleCardTouchMove}
                      onMouseUp={handleCardTouchEnd}
                      onTouchEnd={handleCardTouchEnd}
                      onMouseLeave={handleCardTouchEnd}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      {/* Priority Progress Bar */}
                      {pressState.type === 'priority' && pressState.id === appt.id && (
                        <div className="absolute top-0 left-0 w-full h-1 bg-gray-200 rounded-t-xl overflow-hidden z-20">
                          <div
                            className="h-full bg-amber-500 transition-all duration-[50ms] ease-linear"
                            style={{ width: `${pressState.progress}%` }}
                          />
                        </div>
                      )}
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
                                {/* ... existing time logic ... */}
                                {(() => {
                                  if (showEstimatedTime) {
                                    /* ... existing estimated time logic ... */
                                    const est = estimatedTimes.find(e => e.appointmentId === appt.id);
                                    if (est?.isFirst && clinicStatus === 'In') return null;

                                    const displayTime = est?.estimatedTime || (index === 0 ? '' : format(addMinutes(currentTime, (averageConsultingTime || 15) * index), 'hh:mm a'));
                                    if (!displayTime) return null;

                                    return (
                                      <Badge variant={isSwiping ? 'default' : 'outline'} className={cn("text-xs", isSwiping && 'bg-white/20 text-white')}>
                                        {appt.date && `${appt.date} - `}
                                        {displayTime}
                                      </Badge>
                                    );
                                  }

                                  return (
                                    <Badge variant={isSwiping ? 'default' : 'outline'} className={cn("text-xs", isSwiping && 'bg-white/20 text-white')}>
                                      {appt.date && `${appt.date} - `}
                                      {['Confirmed', 'Completed', 'Cancelled', 'No-show'].includes(appt.status) ? appt.time : getDisplayTime(appt)}
                                    </Badge>
                                  );
                                })()}
                                {showStatusBadge && getStatusBadge(appt)}
                                {appt.isPriority && (
                                  <Badge variant="default" className="ml-2 bg-amber-500 text-white hover:bg-amber-600 border-amber-600 flex gap-1 items-center">
                                    <Star className="h-3 w-3 fill-current" />
                                    Priority
                                  </Badge>
                                )}
                                {!showStatusBadge && appt.status === 'Skipped' && (
                                  <Badge variant="destructive" className="ml-2 bg-yellow-500 text-white hover:bg-yellow-600 border-yellow-600">Late</Badge>
                                )}
                                {onUpdateStatus && isActionable(appt) && !showTopRightActions && (
                                  <div className="flex-1 flex items-center gap-2 ml-2">
                                    {(appt.status === 'Pending' || appt.status === 'Skipped' || appt.status === 'No-show') && (onAddToQueue || onRejoinQueue) && shouldShowConfirmArrival(appt) && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="outline"
                                            size="icon"
                                            className="h-7 w-7 bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                                            onClick={() => (onRejoinQueue && (appt.status === 'Skipped' || appt.status === 'No-show')) ? onRejoinQueue(appt) : onAddToQueue?.(appt)}
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
                                      <div className="flex-1 flex items-center justify-between relative">
                                        {/* Skip Button */}
                                        <div className="relative">
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <Button
                                                variant="outline"
                                                size="icon"
                                                className={cn(
                                                  "h-7 w-7 transition-all duration-200 relative overflow-hidden select-none touch-none",
                                                  pressState.id === appt.id ? "bg-yellow-100 border-yellow-300 scale-110" : "bg-yellow-50 hover:bg-yellow-100 text-yellow-700 border-yellow-200"
                                                )}
                                                disabled={isClinicOut}
                                                onMouseDown={(e) => handlePressStart(e, appt.id)}
                                                onTouchStart={(e) => handlePressStart(e, appt.id)}
                                                onMouseUp={(e) => handlePressEnd(e)}
                                                onMouseLeave={(e) => handlePressEnd(e)}
                                                onTouchEnd={(e) => handlePressEnd(e)}
                                                onContextMenu={(e) => e.preventDefault()}
                                              >
                                                {/* Progress Fill Background */}
                                                <SkipForward className="h-4 w-4 relative z-10 pointer-events-none" />
                                              </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                              <p>{pressState.id === appt.id ? "Hold to skip..." : "Hold 3s to Skip"}</p>
                                            </TooltipContent>
                                          </Tooltip>
                                          {pressState.id === appt.id && (
                                            <div className="absolute -right-3 top-0 h-full w-1.5 bg-gray-200 rounded-full overflow-hidden">
                                              <div
                                                className="w-full bg-yellow-500 transition-all duration-[50ms] ease-linear absolute bottom-0"
                                                style={{ height: `${pressState.progress}%` }}
                                              />
                                            </div>
                                          )}
                                        </div>

                                        {/* Complete Button - Reordered to Right */}
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <Button
                                              variant="default" // Primary action
                                              size="icon"
                                              disabled={isClinicOut}
                                              className="h-10 w-10 bg-green-600 hover:bg-green-700 text-white rounded-full shadow-md ml-2 transition-transform hover:scale-105"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setPendingCompletionId(appt.id);
                                              }}
                                              onMouseDown={(e) => e.stopPropagation()}
                                              onTouchStart={(e) => e.stopPropagation()}
                                            >
                                              <Check className="h-6 w-6" />
                                            </Button>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            <p>Complete Appointment</p>
                                          </TooltipContent>
                                        </Tooltip>

                                        {/* Confirmation Dialog - Triggered after long press */}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                              <div className="flex justify-between items-start mt-1">
                                <div className="flex items-center gap-2">
                                  {showPositionNumber && (
                                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">
                                      {currentPos}
                                    </div>
                                  )}
                                  <div className="flex items-center gap-2">
                                    <p className={cn("font-semibold", isInactive(appt) && 'line-through text-muted-foreground')}>
                                      {(() => {
                                        if (tokenDistribution === 'classic') {
                                          if (appt.status === 'Pending') {
                                            // Hide token number for Pending
                                            return appt.patientName;
                                          }
                                          // For others (Confirmed, Completed, etc), show Classic Token if available
                                          if (appt.classicTokenNumber) {
                                            return `#${appt.classicTokenNumber.toString().padStart(3, '0')} - ${appt.patientName}`;
                                          }
                                          return appt.patientName; // Fallback
                                        }
                                        // Advanced behavior (original)
                                        return ['Completed', 'Cancelled', 'No-show'].includes(appt.status)
                                          ? appt.patientName
                                          : `#${appt.tokenNumber} - ${appt.patientName}`;
                                      })()}
                                    </p>
                                    {appt.skippedAt && (
                                      <Badge variant="outline" className="text-[10px] h-4 px-1 bg-amber-200 border-amber-400 text-amber-800 leading-none flex items-center justify-center font-bold">
                                        Late
                                      </Badge>
                                    )}
                                  </div>
                                </div>

                              </div>

                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                {(appt.age && appt.place) && (
                                  <p className={cn("text-sm", isSwiping ? 'text-white/80' : 'text-muted-foreground')}>
                                    {appt.age} yrs, {appt.place}
                                  </p>
                                )}
                              </div>

                              {isPhoneMode && (
                                <div className="mt-4 pt-4 border-t border-slate-100">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-full h-10 gap-2 bg-green-50 text-green-700 hover:bg-green-100 border-green-200 font-bold"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (appt.communicationPhone) {
                                        window.location.href = `tel:${appt.communicationPhone}`;
                                      }
                                    }}
                                  >
                                    <Phone className="h-4 w-4" />
                                    <span>Call {appt.communicationPhone || 'No Number'}</span>
                                  </Button>
                                </div>
                              )}
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
                              {onTogglePriority && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className={cn(
                                        "h-8 w-8",
                                        appt.isPriority ? "text-amber-500 hover:text-amber-600" : "text-gray-400 hover:text-amber-500"
                                      )}
                                      onClick={() => onTogglePriority(appt)}
                                      disabled={isClinicOut}
                                    >
                                      <Star className={cn("h-5 w-5", appt.isPriority && "fill-current")} />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>{appt.isPriority ? "Remove Priority" : "Mark as Priority"}</p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
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
              )
            })()}
          </div>
        </div>
      </TooltipProvider >
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

      {/* Skip Confirmation Dialog */}
      <AlertDialog open={!!showSkipConfirm} onOpenChange={(open) => !open && setShowSkipConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skip this appointment?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to skip {appointments.find(a => a.id === showSkipConfirm)?.patientName}? They will be moved to the "Skipped" list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-yellow-600 hover:bg-yellow-700"
              onClick={() => {
                if (showSkipConfirm && onUpdateStatus) {
                  onUpdateStatus(showSkipConfirm, 'Skipped');
                  setShowSkipConfirm(null);
                }
              }}
            >
              Confirm Skip
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}

// Memoize the component to prevent unnecessary re-renders
export default memo(AppointmentList);
