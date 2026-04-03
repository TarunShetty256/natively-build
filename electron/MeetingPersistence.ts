// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting } from './db/DatabaseManager';
import { GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT } from './llm';
const crypto = require('crypto');

export class MeetingPersistence {
    private session: SessionTracker;
    private llmHelper: LLMHelper;

    private normalizeStringArray(input: unknown): string[] {
        if (Array.isArray(input)) {
            return input
                .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
                .filter((item) => item.length > 0);
        }

        if (typeof input === 'string') {
            return input
                .split(/\n|•|-\s+/)
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
        }

        return [];
    }

    private extractJsonCandidate(raw: string): string | null {
        const trimmed = (raw || '').trim();
        if (!trimmed) return null;

        const candidates: string[] = [];

        const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fencedMatch?.[1]) {
            candidates.push(fencedMatch[1].trim());
        }

        candidates.push(trimmed);

        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
        }

        for (const candidate of candidates) {
            try {
                JSON.parse(candidate);
                return candidate;
            } catch {
                // Keep trying next candidate
            }
        }

        return null;
    }

    private parseSummaryResponse(raw: string): { overview?: string; actionItems: string[]; keyPoints: string[] } {
        const fallback = { actionItems: [] as string[], keyPoints: [] as string[] };
        const candidate = this.extractJsonCandidate(raw);
        if (!candidate) return fallback;

        try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;

            const overviewCandidate =
                (typeof parsed.overview === 'string' ? parsed.overview : undefined) ||
                (typeof parsed.summary === 'string' ? parsed.summary : undefined) ||
                (typeof parsed.abstract === 'string' ? parsed.abstract : undefined);

            const keyPoints = this.normalizeStringArray(
                parsed.keyPoints ?? parsed.keypoints ?? parsed.key_points ?? parsed.highlights
            );
            const actionItems = this.normalizeStringArray(
                parsed.actionItems ?? parsed.action_items ?? parsed.nextSteps ?? parsed.next_steps ?? parsed.followUps
            );

            return {
                overview: overviewCandidate?.trim() || undefined,
                keyPoints,
                actionItems
            };
        } catch (e) {
            console.error('Failed to parse normalized summary JSON', e);
            return fallback;
        }
    }

    private buildFallbackSummaryFromTranscript(transcript: TranscriptSegment[]): { overview?: string; actionItems: string[]; keyPoints: string[] } {
        const lines = transcript
            .map((segment) => (segment.text || '').replace(/\s+/g, ' ').trim())
            .filter((line) => line.length > 0);

        if (lines.length === 0) {
            return { actionItems: [], keyPoints: [] };
        }

        const overview = lines.slice(0, 2).join(' ').slice(0, 320).trim();

        const keyPoints = Array.from(new Set(lines))
            .slice(0, 4)
            .map((line) => line.length > 180 ? `${line.slice(0, 177).trim()}...` : line);

        const actionItems = lines
            .filter((line) => /\b(next step|follow up|action item|todo|need to|should|will)\b/i.test(line))
            .slice(0, 4)
            .map((line) => line.length > 180 ? `${line.slice(0, 177).trim()}...` : line);

        return {
            overview: overview || undefined,
            keyPoints,
            actionItems
        };
    }

    private buildLegacySummary(summaryData: { overview?: string; actionItems: string[]; keyPoints: string[] }): string {
        const overview = summaryData.overview?.trim();
        if (overview) return overview;

        const keyPoint = summaryData.keyPoints.find((item) => !!item?.trim())?.trim();
        if (keyPoint) return keyPoint;

        const actionItem = summaryData.actionItems.find((item) => !!item?.trim())?.trim();
        if (actionItem) return actionItem;

        return 'See detailed summary';
    }

    constructor(session: SessionTracker, llmHelper: LLMHelper) {
        this.session = session;
        this.llmHelper = llmHelper;
    }

    /**
     * Stops the meeting immediately, snapshots data, and triggers background processing.
     * Returns immediately so UI can switch.
     */
    public async stopMeeting(): Promise<string | null> {
        console.log('[MeetingPersistence] Stopping meeting and queueing save...');

        // 0. Force-save any pending interim transcript
        this.session.flushInterimTranscript();

        // 1. Snapshot valid data BEFORE resetting
        const durationMs = Date.now() - this.session.getSessionStartTime();
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            this.session.reset();
            return null;
        }

        const snapshot = {
            transcript: [...this.session.getFullTranscript()],
            usage: [...this.session.getFullUsage()],
            startTime: this.session.getSessionStartTime(),
            durationMs: durationMs,
            context: this.session.getFullSessionContext()
        };

        // BUG-04 fix: snapshot metadata BEFORE reset() clears it so the
        // background processAndSaveMeeting worker receives the calendar info.
        const metadataSnapshot = this.session.getMeetingMetadata();

        // 2. Reset state immediately so new meeting can start or UI is clean
        this.session.reset();

        const meetingId = crypto.randomUUID();
        this.processAndSaveMeeting(snapshot, meetingId, metadataSnapshot).catch(err => {
            console.error('[MeetingPersistence] Background processing failed:', err);
        });

        // 4. Initial Save (Placeholder)
        const minutes = Math.floor(durationMs / 60000);
        const seconds = ((durationMs % 60000) / 1000).toFixed(0);
        const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

        const placeholder: Meeting = {
            id: meetingId,
            title: "Processing...",
            date: new Date().toISOString(),
            duration: durationStr,
            summary: "Generating summary...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            isProcessed: false
        };

        try {
            DatabaseManager.getInstance().saveMeeting(placeholder, snapshot.startTime, durationMs);
            // Notify Frontend
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
        } catch (e) {
            console.error("Failed to save placeholder", e);
        }

        return meetingId;
    }

    /**
     * Heavy lifting: LLM Title, Summary, and DB Write
     */
    private async processAndSaveMeeting(
        data: { transcript: TranscriptSegment[], usage: any[], startTime: number, durationMs: number, context: string },
        meetingId: string,
        // BUG-04 fix: accept metadata snapshot so calendar info is not lost after session.reset()
        metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' } | null
    ): Promise<void> {
        let title = "Untitled Session";
        let summaryData: { overview?: string; actionItems: string[], keyPoints: string[] } = { actionItems: [], keyPoints: [] };

        // Use passed-in metadata snapshot (NOT this.session.getMeetingMetadata() which is already cleared)
        let calendarEventId: string | undefined;
        let source: 'manual' | 'calendar' = 'manual';

        if (metadata) {
            if (metadata.title) title = metadata.title;
            if (metadata.calendarEventId) calendarEventId = metadata.calendarEventId;
            if (metadata.source) source = metadata.source;
        }

        try {
            // Generate Title (only if not set by calendar)
            if (!metadata || !metadata.title) {
                const titlePrompt = `Generate a concise 3-6 word title for this meeting context. Output ONLY the title text. Do not use quotes or conversational filler.`;
                const groqTitlePrompt = GROQ_TITLE_PROMPT;

                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, data.context.substring(0, 5000), groqTitlePrompt);
                if (generatedTitle) title = generatedTitle.replace(/["*]/g, '').trim();
            }

            // Generate Structured Summary
            if (data.transcript.length > 2) {
                const summaryPrompt = `You are a silent meeting summarizer. Convert this conversation into concise internal meeting notes.
    
    RULES:
    - Do NOT invent information not present in the context
    - You MAY infer implied action items or next steps if they are logical consequences of the discussion
    - Do NOT explain or define concepts mentioned
    - Do NOT use filler phrases like "The meeting covered..." or "Discussed various..."
    - Do NOT mention transcripts, AI, or summaries
    - Do NOT sound like an AI assistant
    - Sound like a senior PM's internal notes
    
    STYLE: Calm, neutral, professional, skim-friendly. Short bullets, no sub-bullets.
    
    Return ONLY valid JSON (no markdown code blocks):
    {
      "overview": "1-2 sentence description of what was discussed",
      "keyPoints": ["3-6 specific bullets - each = one concrete topic or point discussed"],
      "actionItems": ["specific next steps, assigned tasks, or implied follow-ups. If absolutely none found, return empty array"]
    }`;

                const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT;

                const generatedSummary = await this.llmHelper.generateMeetingSummary(summaryPrompt, data.context.substring(0, 10000), groqSummaryPrompt);

                if (generatedSummary) {
                    const parsedSummary = this.parseSummaryResponse(generatedSummary);
                    summaryData = parsedSummary;
                }
            } else {
                console.log("Transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }

        if (!summaryData.overview && summaryData.actionItems.length === 0 && summaryData.keyPoints.length === 0) {
            console.warn('[MeetingPersistence] Summary output empty; using transcript fallback summary.');
            summaryData = this.buildFallbackSummaryFromTranscript(data.transcript);
        }

        try {
            const minutes = Math.floor(data.durationMs / 60000);
            const seconds = ((data.durationMs % 60000) / 1000).toFixed(0);
            const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;
            const legacySummary = this.buildLegacySummary(summaryData);

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: new Date().toISOString(),
                duration: durationStr,
                summary: legacySummary,
                detailedSummary: summaryData,
                transcript: data.transcript,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true
            };

            DatabaseManager.getInstance().saveMeeting(meetingData, data.startTime, data.durationMs);

            // Metadata was already snapshotted before session.reset() — nothing to clear here.

            // Notify Frontend to refresh list
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

        } catch (error) {
            console.error('[MeetingPersistence] Failed to save meeting:', error);
        }
    }

    /**
     * Recover meetings that were started but not fully processed (e.g. app crash)
     */
    public async recoverUnprocessedMeetings(): Promise<void> {
        console.log('[MeetingPersistence] Checking for unprocessed meetings...');
        const db = DatabaseManager.getInstance();
        const unprocessed = db.getUnprocessedMeetings();

        if (unprocessed.length === 0) {
            console.log('[MeetingPersistence] No unprocessed meetings found.');
            return;
        }

        console.log(`[MeetingPersistence] Found ${unprocessed.length} unprocessed meetings. recovering...`);

        for (const m of unprocessed) {
            try {
                const details = db.getMeetingDetails(m.id);
                if (!details) continue;

                console.log(`[MeetingPersistence] Recovering meeting ${m.id}...`);

                const context = details.transcript?.map(t => {
                    const label = t.speaker === 'interviewer' ? 'INTERVIEWER' :
                        t.speaker === 'user' ? 'ME' : 'ASSISTANT';
                    return `[${label}]: ${t.text}`;
                }).join('\n') || "";

                const parts = (details.duration || '0:00').split(':');
                // EC-07 fix: guard against malformed duration strings (e.g. corrupted DB row)
                const mins = parseInt(parts[0]) || 0;
                const secs = parseInt(parts[1]) || 0;
                const durationMs = ((mins * 60) + secs) * 1000;
                const startTime = new Date(details.date).getTime();

                const snapshot = {
                    transcript: details.transcript as TranscriptSegment[],
                    usage: details.usage,
                    startTime: startTime,
                    durationMs: durationMs,
                    context: context
                };

                await this.processAndSaveMeeting(snapshot, m.id);
                console.log(`[MeetingPersistence] Recovered meeting ${m.id}`);

            } catch (e) {
                console.error(`[MeetingPersistence] Failed to recover meeting ${m.id}`, e);
            }
        }
    }
}
