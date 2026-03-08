// electron/knowledge/types.ts
// Generic type definitions for the Knowledge Engine

export enum DocType {
    RESUME = 'resume',
    JD = 'job_description',
    COMPANY_WIKI = 'company_wiki',
    GENERIC = 'generic'
}

/**
 * Represents a document stored in the knowledge base.
 */
export interface KnowledgeDocument {
    id?: number;
    type: DocType;
    source_uri: string;
    structured_data: any; // The JSON extracted from the LLM
    created_at?: string;
}

/**
 * A generalized node of knowledge with embeddings for vector search.
 */
export interface ContextNode {
    id?: number;
    document_id?: number;
    source_type: DocType;
    category: string; // e.g. 'experience', 'requirement', 'company_value'
    title: string;
    text_content: string;
    // Common metadata (optional, depends on source type)
    organization?: string;
    start_date?: string | null;
    end_date?: string | null;
    duration_months?: number; // useful for experience weighting
    tags: string[];
    embedding?: number[];
}

export interface ScoredNode {
    node: ContextNode;
    score: number;
}

export interface KnowledgeStatus {
    hasResume: boolean;
    hasActiveJD: boolean;
    activeMode: boolean; // Is knowledge engine active for chat
    resumeSummary?: {
        name: string;
        role: string;
        totalExperienceYears: number;
    };
    jdSummary?: {
        title: string;
        company: string;
    };
}

// ============================================
// Resume Specific Types
// ============================================

export interface IdentityInfo {
    name: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    github?: string;
    website?: string;
    summary?: string;
}

export interface ExperienceEntry {
    company: string;
    role: string;
    start_date: string; // YYYY-MM
    end_date: string | null; // null = ongoing
    bullets: string[];
}

export interface ProjectEntry {
    name: string;
    description: string;
    technologies: string[];
    url?: string;
}

export interface EducationEntry {
    institution: string;
    degree: string;
    field: string;
    start_date: string;
    end_date: string | null;
    gpa?: string;
}

export interface AchievementEntry {
    title: string;
    description: string;
    date?: string;
}

export interface CertificationEntry {
    name: string;
    issuer: string;
    date?: string;
}

export interface LeadershipEntry {
    role: string;
    organization: string;
    description: string;
}

export interface StructuredResume {
    identity: IdentityInfo;
    skills: string[];
    experience: ExperienceEntry[];
    projects: ProjectEntry[];
    education: EducationEntry[];
    achievements: AchievementEntry[];
    certifications: CertificationEntry[];
    leadership: LeadershipEntry[];
}

export interface SkillExperienceMap {
    [skill: string]: number; // months
}

export interface ProcessedResumeData {
    structured: StructuredResume;
    totalExperienceYears: number;
    skillExperienceMap: SkillExperienceMap;
}

// ============================================
// JD Specific Types
// ============================================

export type JDLevel = 'intern' | 'entry' | 'mid' | 'senior' | 'staff' | 'principal';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship';

export interface StructuredJD {
    title: string;
    company: string;
    location: string;
    description_summary: string;
    level: JDLevel;
    employment_type: EmploymentType;
    min_years_experience: number;
    compensation_hint: string;
    requirements: string[];
    nice_to_haves: string[];
    responsibilities: string[];
    technologies: string[];
    keywords: string[];
}

// ============================================
// Company Research Types
// ============================================

export interface SalaryEstimate {
    title: string;
    location: string;
    min: number;
    max: number;
    currency: string;
    source: string;
    confidence: 'low' | 'medium' | 'high';
}

export interface CompanyDossier {
    company: string;
    hiring_strategy: string;
    interview_focus: string;
    core_values?: string[];
    salary_estimates: SalaryEstimate[];
    competitors: string[];
    recent_news: string;
    sources: string[];
    fetched_at: string;
}

// ============================================
// Advanced Knowledge Pipeline Types
// ============================================

export interface AOTStatus {
    companyResearch: 'pending' | 'running' | 'done' | 'failed';
    negotiationScript: 'pending' | 'running' | 'done' | 'failed';
    gapAnalysis: 'pending' | 'running' | 'done' | 'failed';
    starMapping: 'pending' | 'running' | 'done' | 'failed';
}

export interface SkillGap {
    skill: string;
    gap_type: 'missing' | 'weak';
    pivot_script: string;
    transferable_skills: string[];
}

export interface GapAnalysisResult {
    matched_skills: string[];
    gaps: SkillGap[];
    match_percentage: number;
}

export interface MockQuestion {
    question: string;
    category: 'technical' | 'behavioral' | 'system_design' | 'culture_fit';
    difficulty: 'easy' | 'medium' | 'hard';
    rationale: string;
    suggested_answer_key: string;
}

export interface StarStory {
    original_bullet: string;
    situation: string;
    task: string;
    action: string;
    result: string;
    full_narrative: string;
    parent_role: string;
    parent_company: string;
    timeline: string;
}

export type ToneDirective = 'high_level_business' | 'deep_technical' | 'balanced';

// ============================================
// Intent Classification
// ============================================

export enum IntentType {
    TECHNICAL = 'technical',
    INTRO = 'intro',
    COMPANY_RESEARCH = 'company_research',
    NEGOTIATION = 'negotiation',
    GENERAL = 'general'
}
