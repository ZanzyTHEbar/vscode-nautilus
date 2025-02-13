// performance.ts
import GLib from 'gi://GLib';

// Set up a polyfill if performance is undefined
if (typeof performance === 'undefined') {
    (globalThis as any).performance = {
        now: () => GLib.get_monotonic_time() / 1000, // convert microseconds to milliseconds
    };
}

// Export a helper function for clarity
export function _performance(): number {
    return performance.now();
}
