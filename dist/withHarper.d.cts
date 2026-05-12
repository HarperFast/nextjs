import type { NextConfig } from 'next';
export interface HarperConfig {
    experimentalHarperCache?: boolean;
}
export declare function withHarper(config: NextConfig, harperConfig?: HarperConfig): NextConfig;
