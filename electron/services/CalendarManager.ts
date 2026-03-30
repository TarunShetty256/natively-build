import { app, safeStorage, shell, net } from 'electron';
import axios from 'axios';
import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

// Configuration
// In a real app, these should be in environment variables or build configs
const GOOGLE_CLIENT_ID: string = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET: string = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:11111/auth/callback";
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const TOKEN_PATH = path.join(app.getPath('userData'), 'calendar_tokens.enc');

if (GOOGLE_CLIENT_ID === "YOUR_CLIENT_ID_HERE" || GOOGLE_CLIENT_SECRET === "YOUR_CLIENT_SECRET_HERE") {
    console.warn('[CalendarManager] Google OAuth credentials are using defaults. Calendar features will not work until valid credentials are provided via env vars.');
}

export interface CalendarEvent {
    id: string;
    title: string;
    startTime: string; // ISO
    endTime: string; // ISO
    link?: string;
    source: 'google';
}

export class CalendarManager extends EventEmitter {
    private static instance: CalendarManager;
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private expiryDate: number | null = null;
    private isConnected: boolean = false;
    private updateInterval: NodeJS.Timeout | null = null;
    private notifiedEventIds: Set<string> = new Set();

    private constructor() {
        super();
        // Tokens loaded in init() to ensure safeStorage is ready
    }

    public static getInstance(): CalendarManager {
        if (!CalendarManager.instance) {
            CalendarManager.instance = new CalendarManager();
        }
        return CalendarManager.instance;
    }

    public init() {
        this.loadTokens();
    }

    // =========================================================================
    // Auth Flow
    // =========================================================================

    public async startAuthFlow(): Promise<void> {
        return new Promise((resolve, reject) => {
            // 1. Create Loopback Server
            const server = http.createServer(async (req, res) => {
                try {
                    if (req.url?.startsWith('/auth/callback')) {
                        const qs = new url.URL(req.url, 'http://localhost:11111').searchParams;
                        const code = qs.get('code');
                        const error = qs.get('error');

                        if (error) {
                            res.end('Authentication failed! You can close this window.');
                            server.close();
                            reject(new Error(error));
                            return;
                        }

                        if (code) {
                            res.end('Authentication successful! You can close this window and return to Natively.');
                            server.close();

                            // 2. Exchange code for tokens
                            await this.exchangeCodeForToken(code);
                            resolve();
                        }
                    }
                } catch (err) {
                    res.end('Authentication error.');
                    server.close();
                    reject(err);
                }
            });

            server.listen(11111, () => {
                // 3. Open Browser
                const authUrl = this.getAuthUrl();
                shell.openExternal(authUrl);
            });

            server.on('error', (err) => {
                reject(err);
            });
        });
    }

    public async disconnect(): Promise<void> {
        this.accessToken = null;
        this.refreshToken = null;
        this.expiryDate = null;
        this.isConnected = false;

        if (fs.existsSync(TOKEN_PATH)) {
            fs.unlinkSync(TOKEN_PATH);
        }

        this.emit('connection-changed', false);
    }

    public getConnectionStatus(): { connected: boolean; email?: string, lastSync?: number } {
        // We don't store email in tokens usually, but we could fetch it.
        // For now, simpler boolean.
        return { connected: this.isConnected };
    }

    private getAuthUrl(): string {
        const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            response_type: 'code',
            scope: SCOPES.join(' '),
            access_type: 'offline', // For refresh token
            prompt: 'consent' // Force prompts to ensure we get refresh token
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    private async exchangeCodeForToken(code: string) {
        try {
            const response = await axios.post('https://oauth2.googleapis.com/token', {
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
            });

            this.handleTokenResponse(response.data);
        } catch (error) {
            console.error('[CalendarManager] Token exchange failed:', error);
            throw error;
        }
    }

    // =========================================================================
    // Refresh Logic (NEW)
    // =========================================================================

    public async refreshState(): Promise<void> {
        console.log('[CalendarManager] Refreshing state (Reality Reconciliation)...');

        // 1. Reset Soft Heuristics
        // Clear existing reminder timeouts to prevent double scheduling or stale alerts
        this.reminderTimeouts.forEach(t => clearTimeout(t));
        this.reminderTimeouts = [];

        // 2. Calendar Re-sync & Temporal Re-evaluation
        if (this.isConnected) {
            // Force fetch will also re-schedule reminders based on NEW time
            await this.getUpcomingEvents(true);
        } else {
            console.log('[CalendarManager] Calendar not connected, skipping fetch.');
        }

        // 3. Emit update to UI
        // We emit 'updated' so the frontend knows to re-fetch via getUpcomingEvents
        // or we could push the data. usually ipcHandlers just call getUpcomingEvents.
        this.emit('events-updated');
    }

    private handleTokenResponse(data: any) {
        this.accessToken = data.access_token;
        if (data.refresh_token) {
            this.refreshToken = data.refresh_token; // Only returned on first consent
        }
        this.expiryDate = Date.now() + (data.expires_in * 1000);
        this.isConnected = true;
        this.saveTokens();
        this.emit('connection-changed', true);

        // Initial fetch
        this.fetchUpcomingEvents();
    }

    private async refreshAccessToken() {
        if (!this.refreshToken) {
            throw new Error('No refresh token available');
        }

        try {
            const response = await axios.post('https://oauth2.googleapis.com/token', {
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                refresh_token: this.refreshToken,
                grant_type: 'refresh_token'
            });

            this.handleTokenResponse(response.data);
        } catch (error) {
            console.error('[CalendarManager] Token refresh failed:', error);
            // If refresh fails (e.g. revoked), disconnect
            this.disconnect();
        }
    }

    // =========================================================================
    // Token Storage (Encrypted)
    // =========================================================================

    private saveTokens() {
        if (!safeStorage.isEncryptionAvailable()) {
            console.warn('[CalendarManager] Encryption not available, skipping token save');
            return;
        }

        const data = JSON.stringify({
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiryDate: this.expiryDate
        });

        const encrypted = safeStorage.encryptString(data);
        const tmpPath = TOKEN_PATH + '.tmp';
        fs.writeFileSync(tmpPath, encrypted);
        fs.renameSync(tmpPath, TOKEN_PATH);
    }

    private loadTokens() {
        if (!fs.existsSync(TOKEN_PATH)) return;

        try {
            if (!safeStorage.isEncryptionAvailable()) return;

            const encrypted = fs.readFileSync(TOKEN_PATH);
            const decrypted = safeStorage.decryptString(encrypted);
            const data = JSON.parse(decrypted);

            this.accessToken = data.accessToken;
            this.refreshToken = data.refreshToken;
            this.expiryDate = data.expiryDate;

            if (this.accessToken && this.refreshToken) {
                this.isConnected = true;
                // Check expiry
                if (this.expiryDate && Date.now() >= this.expiryDate) {
                    this.refreshAccessToken();
                }
            }
        } catch (error) {
            console.error('[CalendarManager] Failed to load tokens:', error);
        }
    }

    // =========================================================================
    // Reminders
    // =========================================================================

    private reminderTimeouts: NodeJS.Timeout[] = [];

    private scheduleReminders(events: CalendarEvent[]) {
        // Clear existing
        this.reminderTimeouts.forEach(t => clearTimeout(t));
        this.reminderTimeouts = [];

        const now = Date.now();

        // Drop notifications for events that are no longer upcoming
        for (const id of this.notifiedEventIds) {
            const match = events.find(e => e.id === id);
            if (!match) {
                this.notifiedEventIds.delete(id);
                continue;
            }
            const startTime = new Date(match.startTime).getTime();
            if (!startTime || startTime <= now) {
                this.notifiedEventIds.delete(id);
            }
        }

        events.forEach(event => {
            const startStr = event.startTime;
            if (!startStr) return;

            const startTime = new Date(startStr).getTime();
            if (startTime <= now) return;
            // Reminder time: 8 hours before
            if (this.notifiedEventIds.has(event.id)) return;

            const reminderTime = startTime - (8 * 60 * 60 * 1000);
            const delay = Math.max(0, reminderTime - now);
            // Only schedule if within next 24h (which fetch already limits)
            if (delay < 24 * 60 * 60 * 1000) {
                if (delay === 0) {
                    this.showNotification(event);
                    this.notifiedEventIds.add(event.id);
                    return;
                }

                const timeout = setTimeout(() => {
                    if (this.notifiedEventIds.has(event.id)) return;
                    this.showNotification(event);
                    this.notifiedEventIds.add(event.id);
                }, delay);
                this.reminderTimeouts.push(timeout);
            }
        });
    }

    private showNotification(event: CalendarEvent) {
        const { Notification } = require('electron');
        const startTime = new Date(event.startTime).getTime();
        const timeUntilMs = startTime - Date.now();
        const minutesUntil = Math.max(1, Math.round(timeUntilMs / 60000));
        const hoursUntil = Math.round(minutesUntil / 60);
        const body = minutesUntil >= 60
            ? `"${event.title}" starts in ${hoursUntil} hour${hoursUntil === 1 ? '' : 's'}. Start Natively?`
            : `"${event.title}" starts in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}. Start Natively?`;
        const notif = new Notification({
            title: 'Meeting starting soon',
            body,
            actions: [
                { type: 'button', text: 'Start Meeting' },
                { type: 'button', text: 'Dismiss' }
            ],
            sound: true
        });

        notif.on('action', (event_unused: any, index: number) => {
            if (index === 0) {
                // Start Meeting
                // We need to tell the main process to open window and start meeting
                // Ideally we emit an event that AppState listens to
                this.emit('start-meeting-requested', event);
            }
        });

        notif.on('click', () => {
            // Just open window
            this.emit('open-requested');
        });

        notif.show();
    }

    // =========================================================================
    // Fetch Logic
    // =========================================================================

    public async getUpcomingEvents(force: boolean = false): Promise<CalendarEvent[]> {
        if (!this.isConnected || !this.accessToken) return [];

        // Check expiry
        if (this.expiryDate && Date.now() >= this.expiryDate - 60000) {
            await this.refreshAccessToken();
        }

        const events = await this.fetchEventsInternal();
        this.scheduleReminders(events);
        return events;
    }

    private async fetchEventsInternal(): Promise<CalendarEvent[]> {
        if (!this.accessToken) return [];

        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        try {
            const headers = {
                Authorization: `Bearer ${this.accessToken}`
            };

            let calendarIds: string[] = ['primary'];
            try {
                const calendarsResponse = await axios.get('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
                    headers
                });
                const calendars = calendarsResponse.data.items || [];
                const selectedIds = calendars
                    .filter((cal: any) => cal && cal.selected !== false)
                    .map((cal: any) => cal.id)
                    .filter((id: any) => typeof id === 'string' && id.length > 0);

                if (selectedIds.length > 0) {
                    calendarIds = selectedIds;
                }
            } catch (error) {
                console.warn('[CalendarManager] Failed to fetch calendar list. Falling back to primary calendar.', error);
            }

            const eventResponses = await Promise.all(calendarIds.map(async (calendarId: string) => {
                try {
                    const response = await axios.get(
                        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
                        {
                            headers,
                            params: {
                                timeMin: now.toISOString(),
                                timeMax: tomorrow.toISOString(),
                                singleEvents: true,
                                orderBy: 'startTime'
                            }
                        }
                    );
                    return response.data.items || [];
                } catch (error) {
                    console.warn(`[CalendarManager] Failed to fetch events for calendar: ${calendarId}`, error);
                    return [];
                }
            }));

            const items = eventResponses.flat();

            return items
                .filter((item: any) => {
                    // Filter: >= 5 mins, no all-day
                    if (!item.start.dateTime || !item.end.dateTime) return false; // All-day events have .date instead of .dateTime

                    const start = new Date(item.start.dateTime).getTime();
                    const end = new Date(item.end.dateTime).getTime();
                    const durationMins = (end - start) / 60000;

                    return durationMins >= 5;
                })
                .map((item: any) => ({
                    id: item.id,
                    title: item.summary || '(No Title)',
                    startTime: item.start.dateTime,
                    endTime: item.end.dateTime,
                    link: this.resolveMeetingLink(item),
                    source: 'google'
                }));

        } catch (error) {
            console.error('[CalendarManager] Failed to fetch events:', error);
            return [];
        }
    }

    // Intelligent Link Extraction
    private resolveMeetingLink(item: any): string | undefined {
        // 1. Prefer explicit Hangout link (Google Meet) if valid
        if (item.hangoutLink) return item.hangoutLink;

        // 2. Parse description for other providers
        if (!item.description) return undefined;

        return this.extractMeetingLink(item.description);
    }

    private extractMeetingLink(description: string): string | undefined {
        // Regex for common meeting providers
        // Matches zoom.us, teams.microsoft.com, meet.google.com, webex.com
        const providerRegex = /(https?:\/\/(?:[a-z0-9-]+\.)?(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com|webex\.com)\/[^\s<>"']+)/gi;

        const matches = description.match(providerRegex);
        if (matches && matches.length > 0) {
            // Deduplicate
            const unique = [...new Set(matches)];
            // Return the first valid provider link
            return unique[0];
        }

        // Fallback: Generic URL (less strict, but riskier)
        // const genericUrlRegex = /(https?:\/\/[^\s<>"']+)/g;
        // ... avoided to prevent picking up random links like "docs.google.com"

        return undefined;
    }

    // Background fetcher could go here if needed
    public async fetchUpcomingEvents() {
        // wrapper to just cache or trigger updates
        return this.getUpcomingEvents();
    }
}
