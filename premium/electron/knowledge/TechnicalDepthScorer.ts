import { ToneDirective } from './types';

export class TechnicalDepthScorer {
    public addUtterance(_text: string): void {}

    public getToneXML(): string {
        return '';
    }

    public getToneDirective(): ToneDirective {
        return 'balanced';
    }
}
