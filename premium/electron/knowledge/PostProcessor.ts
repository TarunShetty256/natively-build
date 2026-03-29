import { ProcessedResumeData, StructuredResume } from './types';

export function processResume(structured: StructuredResume): ProcessedResumeData {
    return {
        structured,
        totalExperienceYears: structured.experience?.length ?? 0,
        skillExperienceMap: {}
    };
}
