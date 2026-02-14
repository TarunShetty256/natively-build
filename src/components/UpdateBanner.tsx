import React, { useEffect, useState } from 'react';
import UpdateModal from './UpdateModal';

const UpdateBanner: React.FC = () => {
    const [updateInfo, setUpdateInfo] = useState<any>(null);
    const [parsedNotes, setParsedNotes] = useState<any>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [status, setStatus] = useState<'idle' | 'downloading' | 'ready'>('idle');

    useEffect(() => {
        // Listen for update available
        const unsubAvailable = window.electronAPI.onUpdateAvailable((info: any) => {
            console.log('[UpdateBanner] Update available:', info);
            setUpdateInfo(info);
            // If parsed notes are included in the info object (from our backend change)
            if (info.parsedNotes) {
                setParsedNotes(info.parsedNotes);
            }
            setIsVisible(true);
        });

        // Listen for download progress
        const unsubProgress = window.electronAPI.onDownloadProgress((progressObj) => {
            // Ensure modal is visible if download starts
            if (!isVisible) setIsVisible(true);
            setStatus('downloading');
            setDownloadProgress(progressObj.percent);
        });

        // Listen for update-downloaded event
        const unsubDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
            console.log('[UpdateBanner] Update downloaded:', info);
            setUpdateInfo(info); // Update info again just in case
            if (info.parsedNotes) setParsedNotes(info.parsedNotes);

            setStatus('ready');
            setIsVisible(true);
        });

        return () => {
            unsubAvailable();
            unsubProgress();
            unsubDownloaded();
        };
    }, [isVisible]);

    // Demo/Test mode: Press Cmd+I to trigger backend test-fetch
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // The user specifically mentioned Cmd+I should be working
            // Checking: metaKey + i (case insensitive)
            if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
                e.preventDefault();
                console.log("[UpdateBanner] Cmd+I pressed: Triggering Test Release Fetch...");

                // Call the new test method
                window.electronAPI.testReleaseFetch()
                    .then(result => {
                        if (result.success) {
                            console.log("[UpdateBanner] Test fetch successful");
                        } else {
                            console.error("[UpdateBanner] Test fetch failed:", result.error);
                        }
                    })
                    .catch(err => console.error("[UpdateBanner] Test fetch error:", err));
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const handleInstall = () => {
        setStatus('downloading');
        // Trigger download via IPC
        window.electronAPI.downloadUpdate();
    };

    const handleDismiss = () => {
        setIsVisible(false);
    };

    if (!isVisible) return null;

    return (
        <UpdateModal
            isOpen={isVisible}
            updateInfo={updateInfo}
            parsedNotes={parsedNotes}
            onDismiss={handleDismiss}
            onInstall={handleInstall}
            downloadProgress={downloadProgress}
            status={status}
        />
    );
};

export default UpdateBanner;
