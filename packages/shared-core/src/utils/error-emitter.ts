import { EventEmitter } from 'events';
import type { FirestorePermissionError } from './errors';

type Events = {
    'permission-error': (error: FirestorePermissionError) => void;
};

class ErrorEventEmitter extends EventEmitter {
    emit<T extends keyof Events>(event: T, ...args: Parameters<Events[T]>) {
        return super.emit(event, ...args);
    }

    on<T extends keyof Events>(event: T, listener: Events[T]) {
        return super.on(event, listener);
    }
}

export const errorEmitter = new ErrorEventEmitter();
