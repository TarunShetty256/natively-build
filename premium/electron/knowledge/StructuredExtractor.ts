// electron/knowledge/StructuredExtractor.ts
// LLM call to parse raw text into structured JSON based on Document Type

import { DocType, StructuredResume, StructuredJD } from './types';
import { callWithRetry } from './llmUtils';

const RESUME_SCHEMA = `{
  "identity": {
    "name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin": "",
    "github": "",
    "website": "",
    "summary": ""
  },
  "skills": [],
  "experience": [
    {
      "company": "",
      "role": "",
      "start_date": "YYYY-MM",
      "end_date": "YYYY-MM or null",
      "bullets": []
    }
  ],
  "projects": [
    {
      "name": "",
      "description": "",
      "technologies": [],
      "url": ""
    }
  ],
  "education": [
    {
      "institution": "",
      "degree": "",
      "field": "",
      "start_date": "YYYY-MM",
      "end_date": "YYYY-MM or null",
      "gpa": ""
    }
  ],
  "achievements": [
    {
      "title": "",
      "description": "",
      "date": ""
    }
  ],
  "certifications": [
    {
      "name": "",
      "issuer": "",
      "date": ""
    }
  ],
  "leadership": [
    {
      "role": "",
      "organization": "",
      "description": ""
    }
  ]
}`;

const JD_SCHEMA = `{
  "title": "",
  "company": "",
  "location": "City, Country",
  "description_summary": "",
  "level": "senior",
  "employment_type": "full_time",
  "min_years_experience": 0,
  "compensation_hint": "",
  "requirements": [],
  "nice_to_haves": [],
  "responsibilities": [],
  "technologies": [],
  "keywords": []
}`;

const VALID_LEVELS = ['intern', 'entry', 'mid', 'senior', 'staff', 'principal'];
const VALID_EMPLOYMENT = ['full_time', 'part_time', 'contract', 'internship'];

function buildExtractionPrompt(type: DocType): string {
  const schema = type === DocType.RESUME ? RESUME_SCHEMA : JD_SCHEMA;
  const documentName = type === DocType.RESUME ? "resume" : "job description";

  let extra = '';
  if (type === DocType.JD) {
    extra = `\nNormalize level to one of: ${VALID_LEVELS.join(', ')}.\nNormalize employment_type to one of: ${VALID_EMPLOYMENT.join(', ')}.\nNormalize location to "City, Country" format.\nFor compensation_hint, extract any salary or compensation mentions as a string (e.g. "competitive", "$150k-$200k"). If none, use "".\nFor keywords, extract 5-10 key themes from the JD (e.g. "scalability", "event-driven", "leadership").`;
  }

  return `You are a strict ${documentName} parser.

Extract structured information from the text below into the exact JSON schema specified.
Normalize all dates to YYYY-MM format.
If an end date is ongoing or "Present", return null for end_date.
Do not fabricate identity, company names, dates, or contact information that is not explicitly stated.
For project descriptions: if a description is not explicitly provided, generate a concise 1-sentence summary based on the project name, technologies used, and any available context clues.${extra}
Return ONLY valid JSON. No markdown, no explanation, no commentary.

JSON Schema:
${schema}`;
}

/**
 * Clean JSON response from LLM
 */
function cleanJsonResponse(response: string): string {
  let cleaned = response.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

/**
 * Extract structured data from raw text using LLM.
 */
export async function extractStructuredData<T>(
  rawText: string,
  type: DocType,
  generateContent: (contents: any[]) => Promise<string>
): Promise<T> {
  console.log(`[StructuredExtractor] Starting structured extraction for type: ${type}...`);

  const systemPrompt = buildExtractionPrompt(type);
  const documentName = type === DocType.RESUME ? "RESUME" : "JOB DESCRIPTION";
  const prompt = `${systemPrompt}\n\n--- ${documentName} TEXT ---\n${rawText}\n--- END ${documentName} TEXT ---\n\nReturn ONLY the JSON object. No markdown fences, no explanation.`;

  const response = await callWithRetry(
    () => generateContent([{ text: prompt }]),
    45000 // 45s timeout for structured extraction (larger docs need more time)
  );
  const cleaned = cleanJsonResponse(response);

  try {
    const parsed = JSON.parse(cleaned) as T;

    if (type === DocType.RESUME) {
      const resume = parsed as unknown as StructuredResume;
      if (!resume.identity || !resume.identity.name) {
        throw new Error('Parsed resume missing identity.name');
      }
      // Set defaults
      resume.skills = resume.skills || [];
      resume.experience = resume.experience || [];
      resume.projects = resume.projects || [];
      resume.education = resume.education || [];
      resume.achievements = resume.achievements || [];
      resume.certifications = resume.certifications || [];
      resume.leadership = resume.leadership || [];
      console.log(`[StructuredExtractor] Successfully parsed resume for: ${resume.identity.name}`);
    } else if (type === DocType.JD) {
      const jd = parsed as unknown as StructuredJD;

      // Fallback for LLMs that output 'role' instead of 'title'
      if (!jd.title && (jd as any).role) {
        jd.title = (jd as any).role;
      }

      if (!jd.title) {
        console.warn('[StructuredExtractor] Parsed JD missing title/role. Providing fallback.');
        jd.title = 'Unknown Role';
      }

      // Set defaults
      jd.company = jd.company || 'Unknown Company';
      jd.location = jd.location || 'Unknown Location';
      jd.requirements = jd.requirements || [];
      jd.nice_to_haves = jd.nice_to_haves || [];
      jd.responsibilities = jd.responsibilities || [];
      jd.technologies = jd.technologies || [];
      jd.keywords = jd.keywords || [];
      jd.compensation_hint = jd.compensation_hint || '';
      jd.min_years_experience = jd.min_years_experience || 0;
      // Normalize level
      if (!VALID_LEVELS.includes(jd.level)) {
        jd.level = 'mid' as any;
      }
      // Normalize employment type
      if (!VALID_EMPLOYMENT.includes(jd.employment_type)) {
        jd.employment_type = 'full_time' as any;
      }
      console.log(`[StructuredExtractor] Successfully parsed JD for: ${jd.title} at ${jd.company || 'Unknown'} (Level: ${jd.level})`);
    }

    return parsed;
  } catch (error: any) {
    console.error('[StructuredExtractor] Failed to parse LLM response as JSON:', error.message);
    console.error('[StructuredExtractor] Raw response (first 500 chars):', cleaned.substring(0, 500));
    throw new Error(`Data extraction failed: ${error.message}`);
  }
}
