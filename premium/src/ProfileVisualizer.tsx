import React from 'react';
import { Briefcase, Code, GraduationCap, Calendar, ExternalLink } from 'lucide-react';

interface ExperienceEntry {
    company: string;
    role: string;
    start_date: string;
    end_date: string | null;
    bullets: string[];
}

interface ProjectEntry {
    name: string;
    description: string;
    technologies: string[];
    url?: string;
}

interface EducationEntry {
    institution: string;
    degree: string;
    field: string;
    start_date: string;
    end_date: string | null;
    gpa?: string;
}

interface ProfileData {
    experience?: ExperienceEntry[];
    projects?: ProjectEntry[];
    education?: EducationEntry[];
    [key: string]: any; // Allow additional profile fields
}

interface ProfileVisualizerProps {
    profileData: ProfileData | null;
}

export const ProfileVisualizer: React.FC<ProfileVisualizerProps> = ({ profileData }) => {
    if (!profileData) return null;

    const { experience, projects, education } = profileData;

    const hasExperience = experience && experience.length > 0;
    const hasProjects = projects && projects.length > 0;
    const hasEducation = education && education.length > 0;

    if (!hasExperience && !hasProjects && !hasEducation) return null;

    return (
        <div className="flex flex-col gap-6 mt-6 animated fadeIn">
            {/* Experience Timeline */}
            {hasExperience && (
                <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-8 h-8 rounded-lg bg-green-500/10 text-green-500 border border-green-500/20 flex items-center justify-center">
                            <Briefcase size={14} />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Professional Timeline</h3>
                    </div>

                    <div className="relative pl-6 space-y-10 before:absolute before:inset-0 before:ml-[31px] before:-translate-x-px before:h-full before:w-px before:bg-gradient-to-b before:from-border-muted before:to-transparent">
                        {experience.map((exp, idx) => (
                            <div key={idx} className="relative flex gap-6 group">
                                {/* Timeline Node */}
                                <div className="absolute left-[-29px] top-1.5 h-2 w-2 rounded-full border-[1.5px] border-text-tertiary bg-bg-item-surface group-hover:border-accent-primary group-hover:bg-accent-primary transition-colors z-10" />

                                <div className="flex-1 flex flex-col">
                                    <div className="flex flex-col mb-1.5">
                                        <div className="flex items-center justify-between gap-4">
                                            <h4 className="text-[13px] font-semibold text-text-primary tracking-tight leading-snug group-hover:text-accent-primary transition-colors">{exp.role}</h4>
                                            <div className="flex items-center gap-1.5 text-[10px] font-medium text-text-tertiary uppercase tracking-wider shrink-0">
                                                <span>{exp.start_date}</span>
                                                <span className="text-text-muted">—</span>
                                                <span>{exp.end_date || 'Present'}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <span className="text-[11px] font-medium text-text-secondary">{exp.company}</span>
                                        </div>
                                    </div>

                                    {exp.bullets && exp.bullets.length > 0 && (
                                        <ul className="space-y-2 mt-2">
                                            {exp.bullets.map((bullet, bIdx) => (
                                                <li key={bIdx} className="text-[11px] text-text-secondary leading-relaxed pl-3.5 relative before:absolute before:left-0 before:top-[7px] before:w-[3px] before:h-[3px] before:bg-border-muted before:rounded-full group-hover:before:bg-text-tertiary transition-colors">
                                                    {bullet}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Projects Grid */}
            {hasProjects && (
                <div className="bg-bg-item-surface rounded-xl p-5">
                    <div className="flex items-center gap-3 mb-5">
                        <div className="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center">
                            <Code size={13} />
                        </div>
                        <h3 className="text-[13px] font-semibold text-text-primary tracking-tight">Featured Projects</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {projects.map((proj, idx) => (
                            <div key={idx} className="h-[140px] p-4 rounded-xl bg-bg-input flex flex-col group transition-colors duration-200">
                                <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-[12px] font-semibold text-text-primary tracking-tight line-clamp-1 pr-3">{proj.name}</h4>
                                    {proj.url && (
                                        <a href={proj.url} target="_blank" rel="noreferrer" className="text-text-tertiary hover:text-text-primary transition-colors shrink-0 opacity-0 group-hover:opacity-100">
                                            <ExternalLink size={12} />
                                        </a>
                                    )}
                                </div>
                                <p className="text-[10px] text-text-secondary line-clamp-2 leading-relaxed mb-3 flex-1">
                                    {proj.description}
                                </p>
                                <div className="flex flex-wrap gap-1 mt-auto">
                                    {proj.technologies?.slice(0, 4).map((tech, tIdx) => (
                                        <span key={tIdx} className="px-2 py-[2px] rounded-full bg-bg-item-surface text-[9px] font-medium text-text-tertiary">
                                            {tech}
                                        </span>
                                    ))}
                                    {proj.technologies?.length > 4 && (
                                        <span className="px-2 py-[2px] rounded-full bg-bg-item-surface text-[9px] font-medium text-text-tertiary">
                                            +{proj.technologies.length - 4}
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Education */}
            {hasEducation && (
                <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                    <div className="flex items-center gap-3 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-orange-500/10 text-orange-500 border border-orange-500/20 flex items-center justify-center">
                            <GraduationCap size={14} />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Academic Background</h3>
                    </div>

                    <div className="space-y-4">
                        {education.map((edu, idx) => (
                            <div key={idx} className="flex justify-between items-start border-b border-border-subtle pb-4 last:border-0 last:pb-0">
                                <div className="flex flex-col gap-0.5">
                                    <h4 className="text-sm font-bold text-text-primary tracking-tight">{edu.degree} in {edu.field}</h4>
                                    <span className="text-xs text-text-secondary">{edu.institution}</span>
                                </div>
                                <div className="text-right flex flex-col gap-1 items-end">
                                    <span className="text-[10px] font-bold text-text-tertiary uppercase tracking-wide">{edu.start_date} — {edu.end_date || 'Present'}</span>
                                    {edu.gpa && <span className="text-xs text-text-secondary font-medium">GPA: {edu.gpa}</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
