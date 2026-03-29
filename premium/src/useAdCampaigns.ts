import { useMemo } from 'react';

export type RemoteCampaign = {
    id: string;
    title: string;
    message: string;
    icon?: 'alert' | 'sparkles' | 'info';
    type?: 'promo' | 'info' | 'alert' | string;
    url?: string;
    cta_text?: string;
};

export function useAdCampaigns(
    _isPremium: boolean,
    _hasProfile: boolean,
    _isAppReady: boolean,
    _appStartTime?: number,
    _lastMeetingEndTime?: number | null,
    _isProcessingMeeting?: boolean
) {
    return useMemo(
        () => ({
            activeAd: null as RemoteCampaign | string | null,
            dismissAd: (_id?: string) => {}
        }),
        []
    );
}
