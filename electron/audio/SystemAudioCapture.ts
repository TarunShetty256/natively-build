import { EventEmitter } from 'events';
import { app } from 'electron';
import path from 'path';

let NativeModule: any = null;

try {
    NativeModule = require('natively-audio');
} catch (e) {
    console.error('[SystemAudioCapture] Failed to load native module:', e);
}

const { SystemAudioCapture: RustAudioCapture } = NativeModule || {};

export class SystemAudioCapture extends EventEmitter {
    private monitor: any = null;
    private isRecording: boolean = false;
    private deviceId: string | null = null;
    private detectedSampleRate: number = 16000;
    private isWarmedUp: boolean = false;

    constructor(deviceId?: string | null) {
        super();
        this.deviceId = deviceId || null;
        if (!RustAudioCapture) {
            console.error('[SystemAudioCapture] Rust class implementation not found.');
        } else {
            // Create the native object immediately (instant — just stores device_id)
            try {
                this.monitor = new RustAudioCapture(this.deviceId);
                console.log(`[SystemAudioCapture] Created. Device ID: ${this.deviceId || 'default'}`);
            } catch (e) {
                console.error('[SystemAudioCapture] Failed to create native monitor:', e);
            }
        }
    }

    public getSampleRate(): number {
        return 16000;
    }

    /**
     * Pre-warm SCK: triggers ScreenCaptureKit initialization in a background thread.
     * Call this early (e.g. via setTimeout after app launch) so SCK is fully ready
     * before the user clicks "Start Natively". Audio is captured but discarded
     * until start() is called with the real callback.
     */
    public warmup(): void {
        if (!this.monitor) return;
        if (this.isWarmedUp) return;
        
        try {
            console.log('[SystemAudioCapture] Calling native warmup()...');
            this.monitor.warmup();
            this.isWarmedUp = true;
        } catch (e) {
            console.error('[SystemAudioCapture] Warmup failed:', e);
        }
    }

    /**
     * Start capturing audio. If warmup() was called, this is instant.
     * If not, this will also trigger SCK initialization (slower).
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustAudioCapture) {
            console.error('[SystemAudioCapture] Cannot start: Rust module missing');
            return;
        }

        // Only create if destroyed or failed previously
        if (!this.monitor) {
            console.log('[SystemAudioCapture] Recreating native monitor...');
            try {
                this.monitor = new RustAudioCapture(this.deviceId);
            } catch (e) {
                console.error('[SystemAudioCapture] Failed to create native monitor:', e);
                this.emit('error', e);
                return;
            }
        }

        try {
            console.log('[SystemAudioCapture] Starting native capture...');

            this.monitor.start((chunk: Uint8Array) => {
                if (chunk && chunk.length > 0) {
                    const buffer = Buffer.from(chunk);
                    if (Math.random() < 0.05) {
                        const prefix = buffer.slice(0, 10).toString('hex');
                        console.log(`[SystemAudioCapture] Chunk: ${buffer.length}b, Rate: ${this.detectedSampleRate}, Data(hex): ${prefix}...`);
                    }
                    this.emit('data', buffer);
                }
            });

            this.isRecording = true;
            this.isWarmedUp = true;
            this.emit('start');
        } catch (error) {
            console.error('[SystemAudioCapture] Failed to start:', error);
            this.emit('error', error);
        }
    }

    /**
     * Stop capturing (keeps stream warm for next meeting)
     */
    public stop(): void {
        if (!this.isRecording) return;

        console.log('[SystemAudioCapture] Pausing native capture (keeping stream warm)...');
        try {
            if (this.monitor && this.monitor.pauseCapture) {
                this.monitor.pauseCapture();
            }
        } catch (e) {
            console.error('[SystemAudioCapture] Error pausing:', e);
        }

        this.isRecording = false;
        this.emit('stop');
    }

    /**
     * Completely destroy the native stream.
     */
    public destroy(): void {
        console.log('[SystemAudioCapture] Destroying native monitor completely...');
        try {
            if (this.monitor && this.monitor.stop) {
                this.monitor.stop();
            }
        } catch (e) {}
        this.monitor = null;
        this.isRecording = false;
        this.isWarmedUp = false;
        this.emit('stop');
        this.removeAllListeners();
    }
}
