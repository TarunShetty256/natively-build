import { useState, useEffect } from 'react';

type AdCampaign = 'promo' | 'profile' | 'jd' | null;

export const useAdCampaigns = (
  isPremium: boolean,
  hasProfile: boolean,
  isAppReady: boolean // True when launcher is visible and steady
) => {
    const [activeAd, setActiveAd] = useState<AdCampaign>(null);

    useEffect(() => {
        // Enforce trigger only when the app reaches an "idle/ready" state (e.g. Launcher is visible)
        // so it doesn't pop up over modals or during meeting
        if (!isAppReady) return;

        // 1. Enforce Global Cooldown System
        // We only want to show ONE notification toaster every X hours to avoid annoying the user.
        const lastAdStr = localStorage.getItem('natively_last_ad_shown_time');
        const now = Date.now();
        const cooldownHours = 4; // 4 hours between ANY ad
        
        if (lastAdStr) {
            const lastAdTime = parseInt(lastAdStr, 10);
            const hoursSinceLastAd = (now - lastAdTime) / (1000 * 60 * 60);
            
            // In DEV mode, we skip the cooldown so you can test it easily.
            // In PROD, it stops the script here if the cooldown hasn't passed.
            if (hoursSinceLastAd < cooldownHours && !import.meta.env.DEV) {
                console.log(`[AdCampaigns] Cooldown active. Last ad was ${hoursSinceLastAd.toFixed(1)}h ago.`);
                return;
            }
        }

        // 2. Identify Eligible Campaigns
        // We calculate which ads are actually relevant to this specific user
        // Helper to check if an ad is eligible (not dismissed recently or at all)
        const isAdEligible = (key: string) => {
            const val = localStorage.getItem(key);
            if (!val) return true; // Never dismissed
            
            // Legacy support for older users who have 'true' stored
            if (val === 'true') {
                return false; // Treat as permanently dismissed or we could reset it. Let's respect their old dismissal.
            }

            const dismissedTime = parseInt(val, 10);
            if (isNaN(dismissedTime)) return true;

            const daysSinceDismissal = (now - dismissedTime) / (1000 * 60 * 60 * 24);
            const cooldownDays = import.meta.env.DEV ? 0 : 7; // In DEV always eligible if dismissed, or 0 days. Actually, let's keep it 7 for logic testing, but DEV overrides global cooldown anyway. Let's stick to 7.

            return daysSinceDismissal >= cooldownDays;
        };

        const eligible: AdCampaign[] = [];
        
        if (!isPremium && isAdEligible('natively_promo_toaster_dismissed')) {
            eligible.push('promo');
        }
        
        if (!hasProfile && isAdEligible('natively_profile_toaster_dismissed')) {
            eligible.push('profile');
        }

        // If they have a profile, but no JD uploaded, promote JD awareness
        if (hasProfile && isAdEligible('natively_jd_toaster_dismissed')) {
            eligible.push('jd');
        }

        if (eligible.length === 0) return;

        // 3. Roll the dice for randomness
        // Even if they are eligible and past cooldown, we only have a 60% chance to show an ad.
        // This makes it feel completely organic and unpredictable, like a human marketing team dropping a promo.
        const chance = import.meta.env.DEV ? 1 : 0.6; // 100% in DEV, 60% in PROD
        if (Math.random() > chance) return;

        // 4. Randomly pick ONE of the eligible ads so they don't see the same one every time
        const selectedAd = eligible[Math.floor(Math.random() * eligible.length)];
        
        // 5. Trigger with a "Natural Delay"
        // 1.5s delay makes it feel like a natural incoming message rather than an immediate blocking popup
        const timer = setTimeout(() => {
            setActiveAd(selectedAd);
            localStorage.setItem('natively_last_ad_shown_time', now.toString()); // Start cooldown clock
        }, 1500);

        return () => clearTimeout(timer);

    }, [isAppReady, isPremium, hasProfile]);

    const dismissAd = () => setActiveAd(null);

    return { activeAd, dismissAd };
};
