import React, { useEffect, useMemo, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"

type OnboardingDemoModalProps = {
  isOpen: boolean
  onClose: () => void
  onSkip: () => void
  onComplete: () => void
  onOpenSettings?: () => void
  onStartMeeting?: () => void
}

type OnboardingStep = {
  title: string
  subtitle: string
  bullets: string[]
}

const steps: OnboardingStep[] = [
  {
    title: "Welcome to TeamSync",
    subtitle: "Your AI teammate for meetings, notes, and follow-ups.",
    bullets: [
      "Capture conversations in real time.",
      "Get summaries and action items automatically.",
      "Search meeting insights instantly."
    ]
  },
  {
    title: "Set up your API key",
    subtitle: "Connect your preferred AI provider in under a minute.",
    bullets: [
      "Open Settings > AI Provider.",
      "Paste your API key from OpenAI/Anthropic/Groq.",
      "Run a quick test to confirm the connection."
    ]
  },
  {
    title: "How to start a meeting",
    subtitle: "Start recording from the launcher and let TeamSync do the rest.",
    bullets: [
      "Pick your input/output audio devices.",
      "Click Start Meeting.",
      "Use the overlay for live notes and context prompts."
    ]
  },
  {
    title: "You are all set",
    subtitle: "You can reopen this demo anytime from the launcher.",
    bullets: [
      "Start with a short test meeting.",
      "Review generated notes after ending the call.",
      "Tune settings anytime for better results."
    ]
  }
]

const OnboardingDemoModal: React.FC<OnboardingDemoModalProps> = ({
  isOpen,
  onClose,
  onSkip,
  onComplete,
  onOpenSettings,
  onStartMeeting
}) => {
  const [stepIndex, setStepIndex] = useState(0)
  const [keyStatus, setKeyStatus] = useState<{ hasAIKey: boolean; hasSTTKey: boolean } | null>(null)

  useEffect(() => {
    if (isOpen) {
      setStepIndex(0)
    }
  }, [isOpen])

  useEffect(() => {
    const loadKeyStatus = async () => {
      try {
        const creds = await window.electronAPI?.getStoredCredentials?.()
        if (!creds) return

        const hasAIKey = [
          creds.hasGeminiKey,
          creds.hasGroqKey,
          creds.hasOpenaiKey,
          creds.hasClaudeKey
        ].some(Boolean)

        const hasSTTKey = [
          !!creds.googleServiceAccountPath,
          creds.hasSttGroqKey,
          creds.hasSttOpenaiKey,
          creds.hasDeepgramKey,
          creds.hasElevenLabsKey,
          creds.hasAzureKey,
          creds.hasIbmWatsonKey,
          creds.hasSonioxKey ?? false
        ].some(Boolean)

        setKeyStatus({ hasAIKey, hasSTTKey })
      } catch {
        // Keep onboarding non-blocking if key status cannot be loaded.
      }
    }

    if (isOpen) {
      loadKeyStatus()
    }
  }, [isOpen])

  const step = useMemo(() => steps[stepIndex], [stepIndex])
  const isFirstStep = stepIndex === 0
  const isLastStep = stepIndex === steps.length - 1

  const handleNext = () => {
    if (isLastStep) {
      onComplete()
      return
    }
    setStepIndex((current) => current + 1)
  }

  const handleBack = () => {
    if (!isFirstStep) {
      setStepIndex((current) => current - 1)
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div
            className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
            onClick={onClose}
          />

          <motion.div
            className="relative w-full max-w-[640px] rounded-2xl border border-white/15 bg-[#111214]/95 p-6 shadow-2xl"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.25 }}
          >
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.16em] text-[#8F8F99]">
                  Onboarding Demo
                </p>
                <h2 className="mt-1 text-2xl font-semibold text-white">{step.title}</h2>
                <p className="mt-2 text-sm text-[#B5B6C0]">{step.subtitle}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-2.5 py-1.5 text-xs text-[#B5B6C0] transition hover:bg-white/10 hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="mb-6 space-y-2">
              {step.bullets.map((bullet) => (
                <div
                  key={bullet}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-[#DFE0E6]"
                >
                  {bullet}
                </div>
              ))}
            </div>

            {stepIndex === 1 && onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="mb-3 rounded-lg border border-[#4C8DFF]/35 bg-[#4C8DFF]/15 px-3 py-2 text-sm font-medium text-[#C9DDFF] transition hover:bg-[#4C8DFF]/25"
              >
                Open Settings
              </button>
            )}

            {stepIndex === 1 && keyStatus && (!keyStatus.hasAIKey || !keyStatus.hasSTTKey) && (
              <div className="mb-4 space-y-1.5">
                {!keyStatus.hasAIKey && (
                  <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200">
                    ⚠️ No AI API key detected
                  </p>
                )}
                {!keyStatus.hasSTTKey && (
                  <p className="rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-xs text-rose-200">
                    ⚠️ No STT key detected
                  </p>
                )}
              </div>
            )}

            {stepIndex === 2 && onStartMeeting && (
              <button
                type="button"
                onClick={onStartMeeting}
                className="mb-6 rounded-lg border border-[#4C8DFF]/35 bg-[#4C8DFF]/15 px-3 py-2 text-sm font-medium text-[#C9DDFF] transition hover:bg-[#4C8DFF]/25"
              >
                Try Start Meeting now
              </button>
            )}

            <div className="mb-5 flex items-center gap-2">
              {steps.map((_, index) => (
                <div
                  key={index}
                  className={`h-1.5 rounded-full transition-all ${
                    index === stepIndex ? "w-6 bg-[#5DA0FF]" : "w-3 bg-white/20"
                  }`}
                />
              ))}
            </div>

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={onSkip}
                className="rounded-lg px-3 py-2 text-sm text-[#B5B6C0] transition hover:bg-white/10 hover:text-white"
              >
                Skip
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={isFirstStep}
                  className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-[#0F1012] transition hover:bg-[#E8E8E8]"
                >
                  {isLastStep ? "Finish" : "Next"}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default OnboardingDemoModal
