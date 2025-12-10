
import { EventEmitter } from 'events';

// This is a workaround for the fact that the default EventEmitter type in Node.js is not compatible with the browser.
class BrowserEventEmitter extends EventEmitter {}

export const errorEmitter = new BrowserEventEmitter();
