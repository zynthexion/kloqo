/**
 * Traffic Tracker
 * Standalone, lightweight tracker for ALL patient app visits.
 * Independent of the marketing analytics system.
 */

interface TrafficSession {
    sessionId: string;
    visitorId: string;
    sessionStart: Date;
    patientId?: string;
    phone?: string;
    deviceType: string;
    entryPage: string;
    referrer: string;
}

class TrafficTracker {
    private session: TrafficSession | null = null;
    private hasInitialized: boolean = false;

    init(pathname: string) {
        if (this.hasInitialized || typeof window === 'undefined') return;

        // Skip bots
        if (this.isBot()) return;

        // Get or create persistent visitor ID
        let visitorId = localStorage.getItem('kloqo_visitor_id');
        if (!visitorId) {
            visitorId = `v_${Math.random().toString(36).substring(2, 11)}${Date.now().toString(36)}`;
            localStorage.setItem('kloqo_visitor_id', visitorId);
        }

        this.session = {
            sessionId: `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            visitorId,
            sessionStart: new Date(),
            deviceType: this.getDeviceType(),
            entryPage: pathname,
            referrer: document.referrer || 'direct',
        };

        // Listen for session end
        window.addEventListener('beforeunload', () => this.sendTrafficData());
        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.sendTrafficData();
        });
        window.addEventListener('pagehide', () => this.sendTrafficData());

        this.hasInitialized = true;
        console.log('[Traffic] Tracker initialized:', this.session.sessionId);
    }

    identify(phone?: string, patientId?: string) {
        if (!this.session) return;
        if (phone) this.session.phone = phone;
        if (patientId) this.session.patientId = patientId;
    }

    private sendTrafficData() {
        if (!this.session) return;

        const sessionEnd = new Date();
        const duration = Math.round((sessionEnd.getTime() - this.session.sessionStart.getTime()) / 1000);

        const payload = {
            ...this.session,
            sessionEnd: sessionEnd.toISOString(),
            sessionDuration: duration,
        };

        const endpoint = '/api/analytics/traffic';
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });

        if (navigator.sendBeacon) {
            navigator.sendBeacon(endpoint, blob);
        } else {
            fetch(endpoint, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                keepalive: true,
            }).catch(() => { });
        }

        // Avoid duplicate sends
        this.session = null;
    }

    private isBot(): boolean {
        const ua = navigator.userAgent.toLowerCase();
        return ua.includes('bot') || ua.includes('whatsapp') || ua.includes('facebookexternalhit');
    }

    private getDeviceType(): 'mobile' | 'tablet' | 'desktop' {
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
        if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
        return 'desktop';
    }
}

export const trafficTracker = new TrafficTracker();
