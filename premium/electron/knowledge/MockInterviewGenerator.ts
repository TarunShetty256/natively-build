import { MockQuestion, StructuredJD, StructuredResume } from './types';

export async function generateMockQuestions(
    _resume: StructuredResume,
    _jd: StructuredJD | null,
    _generateContentFn: (contents: any[]) => Promise<string>
): Promise<MockQuestion[]> {
    return [];
}
