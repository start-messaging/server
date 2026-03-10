import { SetMetadata } from '@nestjs/common';

export const SKIP_ONBOARDING_KEY = 'skipOnboarding';
export const SkipOnboarding = () => SetMetadata(SKIP_ONBOARDING_KEY, true);
