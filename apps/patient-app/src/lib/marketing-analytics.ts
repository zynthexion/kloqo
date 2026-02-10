/**
 * Marketing Analytics Tracker
 * Client-side beacon-based session tracking for WhatsApp campaigns
 * 
 * Features:
 * - Single-write session tracking (cost-optimized)
 * - WhatsApp bot detection and filtering
 * - Client-side page view buffering
 * - navigator.sendBeacon for reliable data transmission
 */

interface PageView {
    page: string;
    timestamp: Date;
    timeOnPage: number;
}

interface SessionData {
    sessionId: string;
    sessionStart: Date;
    pages: PageView[];
    actions: string[];
    currentPage: string;
    currentPageStart: Date;

    // Campaign attribution
    ref: string;
    source: string;
    medium: string;
    campaign: string;
    clinicId: string;
    appointmentId?: string;
    phone?: string;
    patientId?: string;
}

class MarketingAnalytics {
    private sessionData: SessionData | null = null;
    private isBot: boolean = false;
    private hasInitialized: boolean = false;

    /**
     * Initialize analytics tracking from URL parameters
     * Call this on app load with magic-login URL params
     */
    init(urlParams: URLSearchParams) {
        if (this.hasInitialized) return;

        // Check if this is a bot
        this.isBot = this.isWhatsAppBot();
        if (this.isBot) {
            console.log('[Analytics] WhatsApp bot detected, skipping tracking');
            return;
        }

        // Extract campaign parameters
        const ref = urlParams.get('ref');
        const campaign = urlParams.get('campaign');

        // Only track if this is a marketing link
        if (!ref || !campaign) {
            return;
        }

        // Initialize session data
        this.sessionData = {
            sessionId: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            sessionStart: new Date(),
            pages: [],
            actions: [],
            currentPage: '',
            currentPageStart: new Date(),

            // Campaign attribution
            ref,
            source: urlParams.get('source') || 'whatsapp',
            medium: urlParams.get('medium') || '',
            campaign,
            clinicId: urlParams.get('clinic') || '',
            appointmentId: urlParams.get('appt') || undefined,
        };

        // Set up beacon on page unload
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', () => this.sendSessionData());
            window.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    this.sendSessionData();
                }
            });

            // Also send on pagehide (for mobile browsers)
            window.addEventListener('pagehide', () => this.sendSessionData());
        }

        this.hasInitialized = true;
        console.log('[Analytics] Session tracking initialized:', this.sessionData.sessionId);
    }

    /**
     * Track a page view (buffered in memory)
     */
    trackPageView(page: string) {
        if (!this.sessionData || this.isBot) return;

        const now = new Date();
        const timeOnPrevPage = now.getTime() - this.sessionData.currentPageStart.getTime();

        // Save previous page data
        if (this.sessionData.currentPage) {
            this.sessionData.pages.push({
                page: this.sessionData.currentPage,
                timestamp: this.sessionData.currentPageStart,
                timeOnPage: timeOnPrevPage / 1000, // Convert to seconds
            });
        }

        // Update current page
        this.sessionData.currentPage = page;
        this.sessionData.currentPageStart = now;
    }

    /**
     * Track an action (e.g., "booked_appointment", "viewed_token")
     */
    trackAction(action: string, value?: any) {
        if (!this.sessionData || this.isBot) return;

        const actionStr = value ? `${action}:${JSON.stringify(value)}` : action;
        this.sessionData.actions.push(actionStr);

        console.log('[Analytics] Action tracked:', actionStr);
    }

    /**
     * Send session data using beacon API (called on page unload)
     */
    private sendSessionData() {
        if (!this.sessionData || this.isBot) return;

        const sessionEnd = new Date();
        const sessionDuration = (sessionEnd.getTime() - this.sessionData.sessionStart.getTime()) / 1000;

        // Add final page if exists
        if (this.sessionData.currentPage) {
            const timeOnCurrentPage = (sessionEnd.getTime() - this.sessionData.currentPageStart.getTime()) / 1000;
            this.sessionData.pages.push({
                page: this.sessionData.currentPage,
                timestamp: this.sessionData.currentPageStart,
                timeOnPage: timeOnCurrentPage,
            });
        }

        // Build simplified page flow
        const pageFlow = this.sessionData.pages.map(p => p.page.replace(/^\//, '')).join(' > ');

        // Get top 5 pages by time spent
        const topPages = [...this.sessionData.pages]
            .sort((a, b) => b.timeOnPage - a.timeOnPage)
            .slice(0, 5)
            .map(p => ({
                page: p.page,
                timeSpent: Math.round(p.timeOnPage),
            }));

        // Build payload
        const payload = {
            sessionId: this.sessionData.sessionId,

            // Attribution
            phone: this.sessionData.phone,
            patientId: this.sessionData.patientId,
            clinicId: this.sessionData.clinicId,
            appointmentId: this.sessionData.appointmentId,

            // Campaign
            ref: this.sessionData.ref,
            source: this.sessionData.source,
            medium: this.sessionData.medium,
            campaign: this.sessionData.campaign,

            // Session metrics
            sessionStart: this.sessionData.sessionStart.toISOString(),
            sessionEnd: sessionEnd.toISOString(),
            sessionDuration: Math.round(sessionDuration),

            // Page metrics
            pageFlow,
            pageCount: this.sessionData.pages.length,
            topPages,

            // Actions
            actions: this.sessionData.actions,

            // Entry/Exit
            entryPage: this.sessionData.pages[0]?.page || '',
            exitPage: this.sessionData.currentPage,

            // Device
            deviceType: this.getDeviceType(),
            isBot: false,
        };

        // Use beacon API for reliable transmission even after tab close
        const endpoint = '/api/analytics/session';
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });

        if (navigator.sendBeacon) {
            const sent = navigator.sendBeacon(endpoint, blob);
            console.log('[Analytics] Session data sent via beacon:', sent);
        } else {
            // Fallback to fetch with keepalive
            fetch(endpoint, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                keepalive: true,
            }).catch(err => console.error('[Analytics] Failed to send session data:', err));
        }

        // Clear session data to prevent duplicate sends
        this.sessionData = null;
    }

    /**
     * Check if current user agent is a WhatsApp bot/crawler
     */
    private isWhatsAppBot(): boolean {
        if (typeof navigator === 'undefined') return false;

        const ua = navigator.userAgent.toLowerCase();
        return (
            ua.includes('whatsapp') ||
            ua.includes('facebookexternalhit') ||
            ua.includes('metadebugger') ||
            ua.includes('bot')
        );
    }

    /**
     * Detect device type from user agent
     */
    private getDeviceType(): 'mobile' | 'desktop' | 'tablet' {
        if (typeof navigator === 'undefined') return 'desktop';

        const ua = navigator.userAgent.toLowerCase();

        if (ua.includes('tablet') || ua.includes('ipad')) {
            return 'tablet';
        }

        if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
            return 'mobile';
        }

        return 'desktop';
    }

    /**
     * Manually trigger session end (useful for testing)
     */
    endSession() {
        this.sendSessionData();
    }
}

// Export singleton instance
export const marketingAnalytics = new MarketingAnalytics();
