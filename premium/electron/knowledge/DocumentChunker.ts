import { ContextNode, DocType, StructuredJD, StructuredResume } from './types';

type NodeInput = Omit<ContextNode, 'embedding'>;

function joinParts(parts: Array<string | undefined | null>): string {
    return parts.filter(Boolean).join('\n').trim();
}

function compactList(items: string[] | undefined, maxItems: number = 8): string {
    if (!items || items.length === 0) return '';
    return items.slice(0, maxItems).join(', ');
}

function makeNode(input: NodeInput): ContextNode {
    return {
        ...input,
        tags: input.tags || [],
    };
}

function buildResumeNodes(resume: StructuredResume): ContextNode[] {
    const nodes: ContextNode[] = [];

    // Identity / summary node
    const identityText = joinParts([
        resume.identity.name ? `Name: ${resume.identity.name}` : '',
        resume.identity.location ? `Location: ${resume.identity.location}` : '',
        resume.identity.summary ? `Summary: ${resume.identity.summary}` : '',
    ]);
    if (identityText) {
        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'identity',
            title: 'Professional Summary',
            text_content: identityText,
            tags: ['identity'],
        }));
    }

    // Skills node
    if (resume.skills?.length) {
        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'skills',
            title: 'Skills',
            text_content: resume.skills.join(', '),
            tags: resume.skills,
        }));
    }

    // Experience nodes
    for (const exp of resume.experience || []) {
        const header = `${exp.role || 'Role'} at ${exp.company || 'Company'}`.trim();
        const dateRange = joinParts([
            exp.start_date ? `Start: ${exp.start_date}` : '',
            exp.end_date ? `End: ${exp.end_date}` : 'End: Present',
        ]);
        const bullets = (exp.bullets || []).filter(Boolean).join(' ');
        const text = joinParts([dateRange, bullets]);

        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'experience',
            title: header,
            text_content: text || header,
            organization: exp.company || undefined,
            start_date: exp.start_date || undefined,
            end_date: exp.end_date || undefined,
            tags: [exp.role, exp.company].filter(Boolean) as string[],
        }));
    }

    // Project nodes
    for (const project of resume.projects || []) {
        const tech = compactList(project.technologies);
        const text = joinParts([
            project.description,
            tech ? `Tech: ${tech}` : '',
            project.url ? `URL: ${project.url}` : '',
        ]);
        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'project',
            title: project.name || 'Project',
            text_content: text || project.name || '',
            tags: project.technologies || [],
        }));
    }

    // Education nodes
    for (const edu of resume.education || []) {
        const text = joinParts([
            edu.degree ? `${edu.degree}${edu.field ? ` in ${edu.field}` : ''}` : '',
            edu.institution ? `Institution: ${edu.institution}` : '',
            edu.gpa ? `GPA: ${edu.gpa}` : '',
            joinParts([
                edu.start_date ? `Start: ${edu.start_date}` : '',
                edu.end_date ? `End: ${edu.end_date}` : 'End: Present',
            ]),
        ]);
        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'education',
            title: edu.institution || 'Education',
            text_content: text || edu.institution || '',
            organization: edu.institution || undefined,
            start_date: edu.start_date || undefined,
            end_date: edu.end_date || undefined,
            tags: [edu.degree, edu.field].filter(Boolean) as string[],
        }));
    }

    // Achievements nodes
    for (const achievement of resume.achievements || []) {
        const text = joinParts([
            achievement.description,
            achievement.date ? `Date: ${achievement.date}` : '',
        ]);
        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'achievement',
            title: achievement.title || 'Achievement',
            text_content: text || achievement.title || '',
            tags: [],
        }));
    }

    // Certification nodes
    for (const cert of resume.certifications || []) {
        const text = joinParts([
            cert.issuer ? `Issuer: ${cert.issuer}` : '',
            cert.date ? `Date: ${cert.date}` : '',
        ]);
        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'certification',
            title: cert.name || 'Certification',
            text_content: text || cert.name || '',
            tags: [cert.issuer].filter(Boolean) as string[],
        }));
    }

    // Leadership nodes
    for (const lead of resume.leadership || []) {
        const text = joinParts([
            lead.organization ? `Organization: ${lead.organization}` : '',
            lead.description || '',
        ]);
        nodes.push(makeNode({
            source_type: DocType.RESUME,
            category: 'leadership',
            title: lead.role || 'Leadership',
            text_content: text || lead.role || '',
            organization: lead.organization || undefined,
            tags: [lead.role, lead.organization].filter(Boolean) as string[],
        }));
    }

    return nodes.filter(node => node.text_content.trim().length > 0);
}

function buildJDNodes(jd: StructuredJD): ContextNode[] {
    const nodes: ContextNode[] = [];

    const summary = joinParts([
        jd.title ? `Role: ${jd.title}` : '',
        jd.company ? `Company: ${jd.company}` : '',
        jd.location ? `Location: ${jd.location}` : '',
        jd.level ? `Level: ${jd.level}` : '',
        jd.employment_type ? `Type: ${jd.employment_type}` : '',
        jd.description_summary ? `Summary: ${jd.description_summary}` : '',
    ]);

    if (summary) {
        nodes.push(makeNode({
            source_type: DocType.JD,
            category: 'jd_summary',
            title: 'Job Summary',
            text_content: summary,
            organization: jd.company || undefined,
            tags: [jd.title, jd.company, jd.level].filter(Boolean) as string[],
        }));
    }

    if (jd.requirements?.length) {
        nodes.push(makeNode({
            source_type: DocType.JD,
            category: 'jd_requirements',
            title: 'Requirements',
            text_content: jd.requirements.join('\n'),
            organization: jd.company || undefined,
            tags: jd.requirements,
        }));
    }

    if (jd.responsibilities?.length) {
        nodes.push(makeNode({
            source_type: DocType.JD,
            category: 'jd_responsibilities',
            title: 'Responsibilities',
            text_content: jd.responsibilities.join('\n'),
            organization: jd.company || undefined,
            tags: jd.responsibilities,
        }));
    }

    if (jd.technologies?.length || jd.keywords?.length) {
        const tech = compactList(jd.technologies, 12);
        const keywords = compactList(jd.keywords, 12);
        const text = joinParts([
            tech ? `Technologies: ${tech}` : '',
            keywords ? `Keywords: ${keywords}` : '',
        ]);
        nodes.push(makeNode({
            source_type: DocType.JD,
            category: 'jd_technologies',
            title: 'Technologies & Keywords',
            text_content: text,
            organization: jd.company || undefined,
            tags: [...(jd.technologies || []), ...(jd.keywords || [])],
        }));
    }

    const comp = joinParts([
        jd.min_years_experience ? `Min experience: ${jd.min_years_experience} years` : '',
        jd.compensation_hint ? `Compensation: ${jd.compensation_hint}` : '',
    ]);
    if (comp) {
        nodes.push(makeNode({
            source_type: DocType.JD,
            category: 'jd_compensation',
            title: 'Compensation & Experience',
            text_content: comp,
            organization: jd.company || undefined,
            tags: [],
        }));
    }

    return nodes.filter(node => node.text_content.trim().length > 0);
}

export async function chunkAndEmbedDocument(
    structuredData: any,
    type: DocType,
    embedFn: (text: string) => Promise<number[]>
): Promise<ContextNode[]> {
    const nodes = type === DocType.RESUME
        ? buildResumeNodes(structuredData as StructuredResume)
        : type === DocType.JD
        ? buildJDNodes(structuredData as StructuredJD)
        : [];

    if (nodes.length === 0) return [];

    const withEmbeddings = await Promise.all(
        nodes.map(async node => {
            const payload = joinParts([node.title, node.text_content]);
            return {
                ...node,
                embedding: await embedFn(payload)
            };
        })
    );

    return withEmbeddings;
}
