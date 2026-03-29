export type CultureMappingResult = {
    mappings: Array<{ value: string; evidence?: string }>;
    core_values: string[];
};

export function findRelevantValueAlignments(
    _question: string,
    mappings: Array<{ value: string; evidence?: string }>,
    _coreValues: string[],
    limit: number
): Array<{ value: string; evidence?: string }> {
    return mappings.slice(0, limit);
}

export function formatValueAlignmentBlock(
    alignments: Array<{ value: string; evidence?: string }>,
    _company?: string
): string {
    if (alignments.length === 0) return '';
    const lines = alignments.map(a => `- ${a.value}${a.evidence ? `: ${a.evidence}` : ''}`);
    return `<culture_alignment>\n${lines.join('\n')}\n</culture_alignment>`;
}
