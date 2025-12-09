export interface ErrorLog {
  id: string;
  error: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  severity: 'low' | 'medium' | 'high' | 'critical';
  context: {
    userId?: string;
    userRole?: string;
    page?: string;
    action?: string;
    deviceInfo?: {
      userAgent: string;
      platform: string;
      language: string;
      screenWidth?: number;
      screenHeight?: number;
    };
    appVersion?: string;
    [key: string]: any;
  };
  timestamp: any;
  appName: 'patient-app' | 'nurse-app' | 'clinic-admin';
  sessionId?: string;
}

export interface ErrorStats {
  total: number;
  bySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  byApp: {
    'patient-app': number;
    'nurse-app': number;
    'clinic-admin': number;
  };
  today: number;
  last24Hours: number;
}

