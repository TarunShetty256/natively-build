// electron/knowledge/GapAnalysisEngine.ts
// Diffs JD requirements vs resume skills and pre-generates pivot scripts

import { StructuredResume, StructuredJD, SkillExperienceMap, SkillGap, GapAnalysisResult } from './types';
import { extractJSONArray, callWithTimeout } from './llmUtils';

/**
 * Analyze gaps between a resume and a job description.
 * First pass: deterministic string matching.
 * Second pass: LLM generates pivot scripts for missing/weak skills.
 */
export async function analyzeGaps(
    resume: StructuredResume,
    jd: StructuredJD,
    skillExperienceMap: SkillExperienceMap,
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<GapAnalysisResult> {
    console.log('[GapAnalysisEngine] Starting gap analysis...');

    // Normalize candidate skills for matching
    const candidateSkillsLower = new Set(
        (resume.skills || []).map(s => s.toLowerCase().trim())
    );

    // Also include skills inferred from experience bullets
    const bulletText = (resume.experience || [])
        .flatMap(e => e.bullets)
        .join(' ')
        .toLowerCase();

    // Collect all required skills from JD
    const jdSkills = [
        ...(jd.requirements || []),
        ...(jd.technologies || [])
    ];

    const matched: string[] = [];
    const rawGaps: { skill: string; gap_type: 'missing' | 'weak' }[] = [];

    for (const skill of jdSkills) {
        const skillLower = skill.toLowerCase().trim();
        const experienceMonths = findSkillExperience(skillLower, skillExperienceMap);

        if (candidateSkillsLower.has(skillLower) || experienceMonths > 6) {
            matched.push(skill);
        } else if (bulletText.includes(skillLower) || experienceMonths > 0) {
            rawGaps.push({ skill, gap_type: 'weak' });
        } else {
            rawGaps.push({ skill, gap_type: 'missing' });
        }
    }

    const totalSkills = matched.length + rawGaps.length;
    const matchPercentage = totalSkills > 0 ? Math.round((matched.length / totalSkills) * 100) : 100;

    console.log(`[GapAnalysisEngine] Match: ${matched.length}/${totalSkills} (${matchPercentage}%), Gaps: ${rawGaps.length}`);

    // Generate pivot scripts for gaps via LLM
    let gaps: SkillGap[] = [];
    if (rawGaps.length > 0) {
        gaps = await generatePivotScripts(rawGaps, resume, generateContentFn);
    }

    console.log(`[GapAnalysisEngine] ✅ Gap analysis complete`);

    return {
        matched_skills: matched,
        gaps,
        match_percentage: matchPercentage
    };
}

/**
 * Find experience months for a skill, with fuzzy matching.
 */
function findSkillExperience(skillLower: string, map: SkillExperienceMap): number {
    // Direct match
    for (const [key, months] of Object.entries(map)) {
        if (key.toLowerCase() === skillLower) return months;
    }
    // Partial match
    for (const [key, months] of Object.entries(map)) {
        if (key.toLowerCase().includes(skillLower) || skillLower.includes(key.toLowerCase())) {
            return months;
        }
    }
    return 0;
}

/**
 * Use LLM to generate pivot scripts for each gap.
 */
async function generatePivotScripts(
    rawGaps: { skill: string; gap_type: 'missing' | 'weak' }[],
    resume: StructuredResume,
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<SkillGap[]> {
    const candidateSkills = (resume.skills || []).join(', ');
    const topExperience = (resume.experience || []).slice(0, 3).map(e =>
        `${e.role} at ${e.company}: ${e.bullets.slice(0, 2).join('; ')}`
    ).join('\n');

    const gapList = rawGaps.map((g, i) =>
        `${i + 1}. "${g.skill}" (${g.gap_type})`
    ).join('\n');

    const prompt = `You are a career coach helping a candidate handle skill gap questions in interviews.

Candidate's Skills: ${candidateSkills}
Top Experience:
${topExperience}

For each missing/weak skill below, generate a realistic "pivot script" — a confident 2-3 sentence response that:
- Acknowledges the gap honestly (if missing) or positions limited experience positively (if weak)
- Pivots to specific transferable skills from the candidate's actual background
- Shows willingness and ability to learn quickly

Gaps:
${gapList}

Return a JSON array (no markdown fences):
[
  {
    "index": 1,
    "pivot_script": "...",
    "transferable_skills": ["skill1", "skill2"]
  }
]

Return ONLY the JSON array.`;

    try {
        const response = await callWithTimeout(
            () => generateContentFn([{ text: prompt }]),
            30000
        );
        const parsed = extractJSONArray(response);

        return parsed.map((item, idx) => {
            const gap = rawGaps[idx]; // Trust array order, not LLM-reported index
            return {
                skill: gap.skill,
                gap_type: gap.gap_type,
                pivot_script: item.pivot_script || '',
                transferable_skills: item.transferable_skills || []
            };
        });
    } catch (error: any) {
        console.error('[GapAnalysisEngine] Failed to generate pivot scripts:', error.message);
        // Return gaps without scripts as fallback
        return rawGaps.map(g => ({
            skill: g.skill,
            gap_type: g.gap_type,
            pivot_script: `While I haven't worked extensively with ${g.skill}, I have strong experience with related technologies and can ramp up quickly.`,
            transferable_skills: [] as string[]
        }));
    }
}
