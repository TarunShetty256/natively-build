import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import { loadNativeModule } from '../../audio/nativeModuleLoader';

type LicenseResult = { success: boolean; error?: string };

type StorageLike = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

const STORAGE_KEY = 'natively_premium_active';
const STORAGE_FILE = 'premium-localStorage.json';
const MONGODB_URI = 'mongodb+srv://tarunshetty256_db_user:126XQ2Ao7Mbd89X1@cluster0.vnezbeg.mongodb.net/?appName=Cluster0';
const MONGODB_DB_NAME = 'natively';
const MONGODB_LICENSE_COLLECTION = 'licenseverify';

let cachedMongoClient: MongoClient | null = null;
let mongoConnectPromise: Promise<MongoClient> | null = null;

async function getMongoClient(): Promise<MongoClient> {
    if (cachedMongoClient) return cachedMongoClient;

    if (!mongoConnectPromise) {
        if (!MONGODB_URI) {
            throw new Error('MongoDB URI not configured.');
        }

        const client = new MongoClient(MONGODB_URI);
        mongoConnectPromise = client.connect().then(() => {
            cachedMongoClient = client;
            return client;
        }).catch((err) => {
            mongoConnectPromise = null;
            throw err;
        });
    }

    return mongoConnectPromise;
}

class MemoryStorage implements StorageLike {
    private data: Record<string, string> = {};

    public getItem(key: string): string | null {
        return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    }

    public setItem(key: string, value: string): void {
        this.data[key] = value;
    }

    public removeItem(key: string): void {
        delete this.data[key];
    }
}

class FileStorage implements StorageLike {
    private filePath: string;
    private loaded = false;
    private data: Record<string, string> = {};

    public constructor(filePath: string) {
        this.filePath = filePath;
    }

    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            if (!fs.existsSync(this.filePath)) return;
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                this.data = parsed as Record<string, string>;
            }
        } catch (err) {
            console.error('[LicenseManager] Failed to load premium state:', err);
            this.data = {};
        }
    }

    private persist(): void {
        try {
            const tmpPath = this.filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
            fs.renameSync(tmpPath, this.filePath);
        } catch (err) {
            console.error('[LicenseManager] Failed to persist premium state:', err);
        }
    }

    public getItem(key: string): string | null {
        this.ensureLoaded();
        return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    }

    public setItem(key: string, value: string): void {
        this.ensureLoaded();
        this.data[key] = value;
        this.persist();
    }

    public removeItem(key: string): void {
        this.ensureLoaded();
        delete this.data[key];
        this.persist();
    }
}

function resolveStorage(): StorageLike {
    const maybeLocalStorage = (globalThis as any)?.localStorage as StorageLike | undefined;
    if (maybeLocalStorage && typeof maybeLocalStorage.getItem === 'function') {
        return maybeLocalStorage;
    }

    if (app?.isReady?.()) {
        const filePath = path.join(app.getPath('userData'), STORAGE_FILE);
        return new FileStorage(filePath);
    }

    return new MemoryStorage();
}

export class LicenseManager {
    private static instance: LicenseManager;
    private storage: StorageLike;
    private premiumActive = false;
    private hasRestored = false;

    private constructor() {
        this.storage = resolveStorage();
        this.restoreState();
        this.hydrateWhenReady();
    }

    public static getInstance(): LicenseManager {
        if (!LicenseManager.instance) {
            LicenseManager.instance = new LicenseManager();
        }
        return LicenseManager.instance;
    }

    public async activateLicense(key: string): Promise<LicenseResult> {
        this.restoreState();
        const trimmed = typeof key === 'string' ? key.trim() : '';
        if (!trimmed) {
            return { success: false, error: 'Invalid license key.' };
        }

        if (process.env.NATIVELY_LICENSE_BYPASS === 'true') {
            console.warn('[LicenseManager] NATIVELY_LICENSE_BYPASS enabled; skipping license verification.');
            this.setPremiumState(true);
            return { success: true };
        }

        if (MONGODB_URI) {
            try {
                const isValid = await this.verifyMongoLicense(trimmed);
                if (isValid) {
                    console.log('[LicenseManager] MongoDB license verification succeeded.');
                } else {
                    console.warn('[LicenseManager] MongoDB license verification failed: license not found.');
                }
                this.setPremiumState(isValid);
                return isValid
                    ? { success: true }
                    : { success: false, error: 'Invalid license key.' };
            } catch (err) {
                console.error('[LicenseManager] MongoDB license verification failed:', err);
            }
        }

        let verify_gumroad_key: ((licenseKey: string) => Promise<unknown>) | undefined;
        try {
            const nativeModule = require('native-module');
            verify_gumroad_key = nativeModule?.verify_gumroad_key;
        } catch (err) {
            console.error('[LicenseManager] Native module unavailable:', err);
            return { success: false, error: 'Native module unavailable.' };
        }

        if (typeof verify_gumroad_key !== 'function') {
            return { success: false, error: 'Native module unavailable.' };
        }

        try {
            const result = await verify_gumroad_key(trimmed);
            if (result === 'OK') {
                this.setPremiumState(true);
                return { success: true };
            }
            return { success: false, error: this.normalizeError(result) };
        } catch (err) {
            console.error('[LicenseManager] License verification failed:', err);
            return { success: false, error: 'License verification failed.' };
        }
    }

    public isPremium(): boolean {
        this.restoreState();
        return this.premiumActive;
    }

    public deactivate(): void {
        this.setPremiumState(false);
    }

    public getHardwareId(): string {
        try {
            const nativeModule = loadNativeModule();
            if (!nativeModule) return 'unavailable';
            return nativeModule.getHardwareId();
        } catch (err) {
            console.error('[LicenseManager] Failed to get hardware ID:', err);
            return 'unavailable';
        }
    }

    private restoreState(): void {
        if (this.hasRestored) return;
        this.hasRestored = true;
        try {
            const stored = this.storage.getItem(STORAGE_KEY);
            this.premiumActive = stored === 'true';
        } catch (err) {
            console.error('[LicenseManager] Failed to restore premium state:', err);
            this.premiumActive = false;
        }
    }

    private setPremiumState(isPremium: boolean): void {
        this.premiumActive = isPremium;
        try {
            this.storage.setItem(STORAGE_KEY, isPremium ? 'true' : 'false');
        } catch (err) {
            console.error('[LicenseManager] Failed to save premium state:', err);
        }
    }

    private normalizeError(result: unknown): string {
        if (typeof result !== 'string') return 'License verification failed.';
        if (result.startsWith('ERR:gumroad:')) {
            const trimmed = result.replace('ERR:gumroad:', '').trim();
            return trimmed || 'License verification failed.';
        }
        return result || 'License verification failed.';
    }

    private async verifyMongoLicense(licenseKey: string): Promise<boolean> {
        const client = await getMongoClient();
        const collection = client.db(MONGODB_DB_NAME).collection(MONGODB_LICENSE_COLLECTION);
        console.log(`[LicenseManager] MongoDB verify: db=${MONGODB_DB_NAME} collection=${MONGODB_LICENSE_COLLECTION}`);
        const doc = await collection.findOne({ licenseKey });
        return !!doc;
    }

    private hydrateWhenReady(): void {
        if (this.storage instanceof MemoryStorage && !app?.isReady?.()) {
            app.whenReady().then(() => {
                try {
                    this.storage = resolveStorage();
                    this.hasRestored = false;
                    this.restoreState();
                    this.setPremiumState(this.premiumActive);
                } catch (err) {
                    console.error('[LicenseManager] Failed to hydrate premium storage:', err);
                }
            }).catch((): void => undefined);
        }
    }
}
