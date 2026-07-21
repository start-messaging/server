import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { User } from '../../src/users/entities/user.entity.js';
import { UserRole } from '../../src/users/enums/user-role.enum.js';
import { KycStatus } from '../../src/users/enums/kyc-status.enum.js';
import { unwrap } from './envelope.js';

export const DEFAULT_PASSWORD = 'Passw0rd!123';

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}@example.test`;
}

/** Distinct valid Indian mobile per call. */
export function uniqueMobileIN(): string {
  counter += 1;
  const suffix = String(6000000000 + (counter % 3999999999)).slice(0, 9);
  return `+91${9}${suffix.slice(0, 9)}`;
}

export interface RegisteredUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
}

export function userRepo(app: INestApplication): Repository<User> {
  return app.get<Repository<User>>(getRepositoryToken(User));
}

export function signToken(
  app: INestApplication,
  payload: { id: string; email: string; role: string },
): string {
  const jwt = app.get(JwtService, { strict: false });
  return jwt.sign({
    sub: payload.id,
    email: payload.email,
    role: payload.role,
  });
}

export async function registerUser(
  app: INestApplication,
  emailPrefix = 'user',
): Promise<RegisteredUser> {
  const email = uniqueEmail(emailPrefix);
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      email,
      password: DEFAULT_PASSWORD,
      firstName: 'Test',
      lastName: 'User',
    })
    .expect(201);
  const data = unwrap<{ accessToken: string; user: { id: string } }>(res.body);
  return {
    id: data.user.id,
    email,
    password: DEFAULT_PASSWORD,
    accessToken: data.accessToken,
  };
}

/** Register a user and elevate them to admin, returning an admin-role token. */
export async function createAdmin(
  app: INestApplication,
): Promise<RegisteredUser> {
  const u = await registerUser(app, 'admin');
  await userRepo(app).update({ id: u.id }, { role: UserRole.ADMIN });
  return {
    ...u,
    accessToken: signToken(app, {
      id: u.id,
      email: u.email,
      role: UserRole.ADMIN,
    }),
  };
}

/** Mark a user onboarded so the OnboardingGuard lets them through. */
export async function onboardUser(
  app: INestApplication,
  userId: string,
): Promise<void> {
  await userRepo(app).update(
    { id: userId },
    {
      kycStatus: KycStatus.APPROVED,
      mobileVerified: true,
      hasCompletedOnboarding: true,
    },
  );
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}
