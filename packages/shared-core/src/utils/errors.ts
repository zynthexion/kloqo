export type SecurityRuleContext = {
    path: string;
    operation: 'get' | 'list' | 'create' | 'update' | 'delete' | 'write';
    requestResourceData?: any;
};

export class FirestorePermissionError extends Error {
    public context: SecurityRuleContext;

    constructor(context: SecurityRuleContext) {
        const message = `FirestoreError: Missing or insufficient permissions.`;
        super(message);
        this.name = 'FirestorePermissionError';
        this.context = context;

        // This is to ensure the stack trace is captured correctly
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, FirestorePermissionError);
        }
    }
}
