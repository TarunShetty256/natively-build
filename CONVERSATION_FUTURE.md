# Conversation Future

This document captures planned conversation capabilities for Natively so future work stays aligned and easy to scope.

## Goals
- Provide interview-ready responses with minimal latency.
- Detect intent and context reliably from transcripts and user input.
- Keep answers concise, structured, and action-oriented.
- Support both coding and system design interview workflows.

## Planned Features
### System Design Interview Specialization
- Templates: structured prompts for requirements, constraints, trade-offs, scalability.
- Playbooks: reusable scaffolds for APIs, data models, caching, queues, SLAs.
- Knowledge base: curated system design references and examples.
- Interactive flow: ask clarifying questions, then produce a step-by-step design.

### Repo-Aware Explanations
- Local repo indexing and embeddings.
- Retrieval of relevant files and snippets.
- Cite file paths and key references in responses.
- Cache and re-index triggers for performance.

### UI and Interaction
- Contextual buttons shown based on detected intent (e.g., System Design).
- Mode indicator for Assist, Answer, and System Design flows.
- Clear hand-off between automatic and manual triggers.

## Integration Points (Current Codebase)
- LLM routing and modes: electron/IntelligenceEngine.ts
- Prompt definitions: electron/llm/prompts.ts
- RAG pipeline: electron/rag/RAGManager.ts
- Chat UI: src/components/MeetingChatOverlay.tsx

## Open Questions
- Should system design mode use a dedicated panel or the existing chat stream?
- What is the minimum local knowledge base size for good results?
- How should we let users provide context (JD, company profile, constraints)?

## Milestones
1. Add system design prompt + intent detection.
2. Add system design button and UI entry point.
3. Add curated knowledge base ingestion.
4. Add repo-aware retrieval and citations.
