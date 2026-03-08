import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, Sparkles, CheckCircle } from 'lucide-react';
import { cn } from '../../src/lib/utils';
import { useShortcuts } from '../../src/hooks/useShortcuts';

interface PremiumPromoToasterProps {
    className?: string;
    isOpen: boolean;
    onDismiss: () => void;
    onUpgrade: () => void;
}

export const PremiumPromoToaster: React.FC<PremiumPromoToasterProps> = ({ className, isOpen, onDismiss, onUpgrade }) => {
    const [isButtonHovered, setIsButtonHovered] = useState(false);

        // DEV OVERRIDE: For testing, press Ctrl/Cmd + B
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!import.meta.env.DEV) return;
            if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
                e.preventDefault();
                if (isOpen) onDismiss();
                // We can't easily trigger the hook's dev override from here cleanly without global state,
                // but we'll leave this empty or let the hook handle dev triggers.
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onDismiss]);

    const handleDismiss = () => {
        localStorage.setItem('natively_promo_toaster_dismissed', Date.now().toString());
        onDismiss();
    };

    const handlePrimaryAction = () => {
        localStorage.setItem('natively_promo_toaster_dismissed', Date.now().toString());
        onDismiss();
        onUpgrade();
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.94, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15, ease: [0.32, 0, 0.67, 0] } }}
                        transition={{ type: "spring", stiffness: 450, damping: 35 }}
                        className={cn(
                            "relative w-[480px] overflow-hidden",
                            "rounded-[24px]",
                            "bg-[#09090B]",
                            "border border-white/[0.08]",
                            "shadow-[0_32px_64px_-16px_rgba(0,0,0,0.8),0_8px_32px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)]",
                            "flex flex-col items-center pb-[24px]",
                            className
                        )}
                    >
                        {/* Sophisticated Background Structure */}
                        <div className="absolute inset-0 bg-[#0A0A0C]" />
                        <div className="absolute top-0 left-0 right-0 h-[300px] bg-gradient-to-b from-white/[0.03] to-transparent pointer-events-none" />
                        
                        {/* Refined Border Sparkle (Top Only) */}
                        <div className="absolute top-0 left-[20%] right-[20%] h-px bg-gradient-to-r from-transparent via-white/[0.15] to-transparent" />
                        
                        {/* Content Container */}
                        <div className="relative z-10 w-full flex flex-col items-center pt-[48px]">
                            
                            {/* The "Prism" - A custom, human-feeling visual */}
                            <div className="relative w-[64px] h-[64px] mb-[32px]">
                                <motion.div 
                                    animate={{ 
                                        rotate: [0, 10, 0, -10, 0],
                                        scale: [1, 1.05, 1]
                                    }}
                                    transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
                                    className="absolute inset-0 flex items-center justify-center"
                                >
                                    {/* Layered Glass Triangles for a 'Prism' effect */}
                                    <div className="absolute w-full h-full border border-white/20 rotate-45 rounded-[12px] backdrop-blur-sm bg-white/[0.02]" />
                                    <div className="absolute w-[80%] h-[80%] border border-white/10 -rotate-12 rounded-[8px]" />
                                    <Zap size={24} className="text-white relative z-10 drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]" fill="white" />
                                </motion.div>
                                {/* Subtle Glow beneath the Prism */}
                                <div className="absolute inset-0 bg-white/5 blur-[20px] rounded-full scale-150" />
                            </div>

                            {/* Typography - Bold, Impactful, Human */}
                            <div className="text-center px-[40px] mb-[40px]">
                                <h3 className="text-[32px] font-[700] leading-[1.1] text-white tracking-[-0.04em] mb-[12px] antialiased">
                                    The Unfair Advantage.
                                </h3>
                                <p className="text-[15px] leading-[1.6] text-white/50 max-w-[320px] mx-auto font-medium antialiased">
                                    Combined <span className="text-white/80">Resume Context</span> & <span className="text-white/80">JD Intelligence</span>. One lifetime unlock.
                                </p>
                            </div>

                            {/* The "Membership Card" - Pricing Section */}
                            <div className="w-[380px] rounded-[20px] bg-gradient-to-b from-white/[0.04] to-transparent border border-white/[0.06] p-[24px] mb-[40px] relative overflow-hidden group">
                                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                    <Sparkles size={48} className="text-white" />
                                </div>
                                
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30">Early Adopter Bundle</span>
                                    <div className="px-2 py-0.5 rounded-full bg-white text-black text-[9px] font-black tracking-tighter">
                                        50% OFF
                                    </div>
                                </div>

                                <div className="flex items-end gap-3 leading-none">
                                    <div className="flex items-baseline gap-1.5">
                                        <span className="text-[48px] font-[700] text-white leading-none tracking-[-0.02em]">$5</span>
                                        <span className="text-[14px] font-bold text-white/40 mb-1.5">USD</span>
                                    </div>
                                    <div className="h-[24px] w-px bg-white/10 mx-1 mb-2" />
                                    <div className="mb-2">
                                        <span className="text-[13px] font-semibold text-white/60 block leading-tight">Lifetime Access</span>
                                        <span className="text-[11px] font-medium text-white/20 line-through tracking-wide">Regularly $10.00</span>
                                    </div>
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="w-full px-[48px] flex flex-col gap-5">
                                <button
                                    onClick={handlePrimaryAction}
                                    className="relative w-full h-[54px] rounded-[18px] bg-white text-black font-[700] text-[16px] transition-all hover:scale-[1.02] active:scale-[0.98] shadow-[0_20px_40px_-12px_rgba(255,255,255,0.2)] overflow-hidden group/btn"
                                >
                                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent -translate-x-full group-hover/btn:animate-[shimmer_1.5s_infinite]" />
                                    <style>{`
                                        @keyframes shimmer {
                                            100% { transform: translateX(100%); }
                                        }
                                    `}</style>
                                    <span className="relative z-10">Claim the Advantage</span>
                                </button>

                                <button
                                    onClick={handleDismiss}
                                    className="text-[13px] text-white/20 font-bold hover:text-white/40 transition-colors duration-200 uppercase tracking-[0.15em]"
                                >
                                    Maybe later
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
