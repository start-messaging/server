import { ApiProperty } from '@nestjs/swagger';

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    mobileNumber: string | null;
    companyName: string | null;
    websiteUrl: string | null;
    hasCompletedOnboarding: boolean;
    isActive: boolean;
    country: string | null;
  };
}
