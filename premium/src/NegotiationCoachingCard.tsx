import React, { useEffect, useMemo, useState } from 'react';
import { MessageSquareQuote, Target, Wallet, Timer } from 'lucide-react';

interface NegotiationCoachingCardProps {
  tacticalNote: string;
  exactScript: string;
  showSilenceTimer: boolean;
  phase: string;
  theirOffer: number | null;
  yourTarget: number | null;
  currency: string;
  onSilenceTimerEnd?: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  INACTIVE: 'Getting Started',
  PROBE: 'Exploring The Range',
  ANCHOR: 'Recruiter Made An Offer',
  COUNTER: 'Countering Strategically',
  HOLD: 'Holding Position',
  PIVOT_BENEFITS: 'Pivot To Total Comp',
  CLOSE: 'Closing The Offer',
};

function formatMoney(amount: number | null, currency: string): string {
  if (amount === null) return 'Not shared yet';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency || 'USD'} ${amount.toLocaleString()}`;
  }
}

export const NegotiationCoachingCard: React.FC<NegotiationCoachingCardProps> = ({
  tacticalNote,
  exactScript,
  showSilenceTimer,
  phase,
  theirOffer,
  yourTarget,
  currency,
  onSilenceTimerEnd,
}) => {
  const [secondsLeft, setSecondsLeft] = useState(6);

  const phaseLabel = useMemo(() => PHASE_LABELS[phase] || 'Live Negotiation', [phase]);

  useEffect(() => {
    if (!showSilenceTimer) return;

    setSecondsLeft(6);

    // Keep silence timing deterministic so users can pause confidently before speaking.
    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onSilenceTimerEnd?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [showSilenceTimer, onSilenceTimerEnd]);

  return (
    <div className="rounded-2xl border border-emerald-400/25 bg-gradient-to-b from-emerald-500/10 to-transparent p-4 shadow-[0_10px_30px_-16px_rgba(16,185,129,0.65)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-200">
          <Target className="h-3.5 w-3.5" />
          <span>{phaseLabel}</span>
        </div>

        {showSilenceTimer && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-400/10 px-2 py-1 text-[11px] font-semibold text-amber-200">
            <Timer className="h-3.5 w-3.5" />
            <span>Pause {secondsLeft}s</span>
          </div>
        )}
      </div>

      <div className="mb-3 rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          <MessageSquareQuote className="h-3.5 w-3.5" />
          <span>Tactical Note</span>
        </div>
        <p className="text-[13px] leading-relaxed text-slate-100">{tacticalNote}</p>
      </div>

      <div className="mb-3 rounded-xl border border-emerald-300/25 bg-emerald-400/10 p-3">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-200">Say This</p>
        <p className="text-[14px] leading-relaxed text-emerald-50">{exactScript}</p>
      </div>

      <div className="grid grid-cols-1 gap-2 text-[12px] text-slate-300 sm:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
          <p className="mb-1 inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide text-slate-400">
            <Wallet className="h-3.5 w-3.5" />
            Their Offer
          </p>
          <p className="font-medium text-slate-100">{formatMoney(theirOffer, currency)}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
          <p className="mb-1 inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide text-slate-400">
            <Target className="h-3.5 w-3.5" />
            Your Target
          </p>
          <p className="font-medium text-slate-100">{formatMoney(yourTarget, currency)}</p>
        </div>
      </div>
    </div>
  );
};
